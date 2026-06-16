// =============================================================================
// CHEMREPORT PRO — SERVICE WORKER v2.0
// Estratégia: Cache-First para App Shell + Background Sync para relatórios
// =============================================================================

// Importa Dexie para acesso ao IndexedDB dentro do contexto do SW
importScripts('https://unpkg.com/dexie/dist/dexie.js');

const CACHE_NAME = 'chemreport-pro-v2';

// Credenciais Supabase — usadas nas chamadas REST diretas durante o sync offline
// O SDK JS do Supabase não está disponível no contexto do Service Worker
const SUPABASE_URL = 'https://lzfwskhtgbbzgnwulixk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_YrDPtMvX2HQ5VRDMeZr6JA_vxrtWkyC';

// Recursos do App Shell: tudo que o app precisa para abrir sem internet
// Estes são pré-cacheados no evento 'install'
const APP_SHELL_URLS = [
    './index.html',
    './manifest.json',
    './sw.js',
    'https://unpkg.com/dexie/dist/dexie.js',
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
];

// =============================================================================
// EVENTO: INSTALL
// Pré-cacheia o App Shell para garantir abertura offline instantânea.
// Usa Promise.allSettled para que uma falha num recurso CDN não aborte
// toda a instalação — o app ainda funciona com o que foi cacheado.
// =============================================================================
self.addEventListener('install', event => {
    console.log('[SW] Instalando ChemReport Pro...');

    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            // Cache individual com fallback silencioso por recurso
            const cachePromises = APP_SHELL_URLS.map(url =>
                cache.add(url).catch(err => {
                    // Falha em CDNs externas não deve impedir a instalação
                    console.warn(`[SW] Não foi possível cachear: ${url}`, err.message);
                })
            );
            return Promise.all(cachePromises);
        }).then(() => {
            console.log('[SW] App Shell cacheado com sucesso.');
            // Activa o SW imediatamente, sem esperar que as tabs antigas fechem
            return self.skipWaiting();
        })
    );
});

// =============================================================================
// EVENTO: ACTIVATE
// Remove caches de versões anteriores do SW para libertar espaço em disco.
// self.clients.claim() faz o SW assumir controlo das tabs abertas imediatamente.
// =============================================================================
self.addEventListener('activate', event => {
    console.log('[SW] Activando v2...');

    event.waitUntil(
        caches.keys()
            .then(cacheNames =>
                Promise.all(
                    cacheNames
                        .filter(name => name !== CACHE_NAME) // Elimina caches de versões antigas
                        .map(name => {
                            console.log(`[SW] Eliminando cache obsoleto: ${name}`);
                            return caches.delete(name);
                        })
                )
            )
            .then(() => self.clients.claim()) // Toma controlo imediato de todas as tabs
    );
});

// =============================================================================
// EVENTO: FETCH
// Estratégia: Cache-First com actualização em background (Stale-While-Revalidate)
//
// Regras de intercepção:
//   - Chamadas à API do Supabase → NUNCA interceptar (dados em tempo real)
//   - Métodos não-GET (POST, PATCH, etc.) → NUNCA interceptar
//   - Extensões do browser → NUNCA interceptar
//   - Tudo o resto → Cache-First
// =============================================================================
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // --- Exclusões: recursos que nunca devem ser servidos do cache ---
    const isSupabaseCall   = url.hostname.includes('supabase.co');
    const isNonGetRequest  = request.method !== 'GET';
    const isBrowserExtension = url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:';

    if (isSupabaseCall || isNonGetRequest || isBrowserExtension) {
        return; // Deixa o browser tratar normalmente
    }

    event.respondWith(
        caches.match(request).then(cachedResponse => {

            if (cachedResponse) {
                // CACHE HIT — Serve imediatamente do cache (zero latência)
                // Em background, actualiza o cache com a versão mais recente da rede
                const isCDNResource = url.hostname !== self.location.hostname;
                if (isCDNResource) {
                    // Fire-and-forget: actualiza sem bloquear a resposta ao utilizador
                    fetch(request).then(freshResponse => {
                        if (freshResponse && freshResponse.ok) {
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(request, freshResponse.clone());
                            });
                        }
                    }).catch(() => {}); // Falha silenciosa — já temos o cache
                }
                return cachedResponse;
            }

            // CACHE MISS — Busca da rede e armazena para a próxima visita
            return fetch(request).then(networkResponse => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'opaque') {
                    return networkResponse;
                }
                const responseToStore = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(request, responseToStore));
                return networkResponse;
            }).catch(err => {
                // Rede indisponível e sem cache: falha silenciosa
                console.warn('[SW] Recurso indisponível offline:', request.url);
                // Poderia retornar uma página de fallback offline aqui
            });
        })
    );
});

// =============================================================================
// EVENTO: SYNC (Background Sync API)
// Disparado automaticamente pelo browser quando a conectividade é restaurada.
// A tag 'sync-relatorios' é registada pela app quando há dados pendentes.
//
// Se a função syncPendingReports() lançar uma excepção, o browser irá
// RETENTAR automaticamente com backoff exponencial. Portanto:
//   - Erros de REDE → re-lançar para forçar retry
//   - Erros de DADOS (schema, auth) → não re-lançar para evitar loop infinito
// =============================================================================
self.addEventListener('sync', event => {
    console.log('[SW] Background Sync disparado. Tag:', event.tag);

    if (event.tag === 'sync-relatorios') {
        // event.waitUntil mantém o SW vivo até a Promise resolver
        event.waitUntil(syncPendingReports());
    }
});

// =============================================================================
// FUNÇÃO CORE: syncPendingReports()
// Lê relatórios finalizados do IndexedDB (Dexie), envia em batch ao Supabase
// via API REST, e move os registos enviados com sucesso para a tabela de
// sincronizados, limpando a fila de pendentes.
// =============================================================================
async function syncPendingReports() {
    // Inicializa o Dexie no contexto do SW — deve espelhar exactamente
    // o schema definido na aplicação principal para compartilhar os dados
    const db = new Dexie('ChemReportDB');
    db.version(1).stores({
        relatorios_pendentes:     'id, username, status, updated_at',
        relatorios_sincronizados: 'id, username, status, updated_at'
    });

    // Lê apenas relatórios FINALIZADOS (ignora rascunhos em progresso)
    let pendingRecords;
    try {
        pendingRecords = await db.relatorios_pendentes
            .filter(record => record.status === 'finalizado')
            .toArray();
    } catch (dbErr) {
        console.error('[SW] Erro ao ler IndexedDB:', dbErr);
        throw dbErr; // Re-lança para forçar retry do browser
    }

    if (pendingRecords.length === 0) {
        console.log('[SW] Nenhum relatório pendente para sincronizar.');
        return;
    }

    console.log(`[SW] Sincronizando ${pendingRecords.length} relatório(s) pendente(s)...`);

    const results = { synced: [], failed: [] };

    for (const record of pendingRecords) {
        try {
            // Chamada REST directa ao Supabase (upsert via header Prefer)
            // POST com 'resolution=merge-duplicates' comporta-se como UPSERT
            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/relatorios_quimica`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey':         SUPABASE_KEY,
                        'Authorization':  `Bearer ${SUPABASE_KEY}`,
                        // merge-duplicates: actualiza se o id já existir
                        // return=minimal: não retorna o registo inserido (mais rápido)
                        'Prefer': 'resolution=merge-duplicates,return=minimal'
                    },
                    body: JSON.stringify({
                        id:         record.id,
                        username:   record.username,
                        status:     record.status,
                        form_data:  record.form_data,
                        updated_at: record.updated_at
                    })
                }
            );

            if (!response.ok) {
                // Erro do servidor (ex: violação de RLS, schema inválido)
                const errorBody = await response.text();
                console.error(`[SW] Supabase recusou registo ${record.id} [${response.status}]:`, errorBody);
                results.failed.push(record.id);
                // NÃO re-lança — erro de dados não deve causar retry infinito
                continue;
            }

            // Sucesso: arquiva em sincronizados e remove da fila de pendentes
            await db.relatorios_sincronizados.put(record);
            await db.relatorios_pendentes.delete(record.id);
            results.synced.push(record.id);
            console.log(`[SW] Relatório ${record.id} sincronizado com sucesso.`);

        } catch (networkErr) {
            // Erro de rede puro (sem conectividade) — mantém na fila, propaga o erro
            console.error(`[SW] Erro de rede ao sincronizar ${record.id}:`, networkErr.message);
            results.failed.push(record.id);
            // Re-lança apenas se TODOS falharem por rede para forçar retry global
        }
    }

    console.log('[SW] Sincronização concluída:', results);

    // Notifica todas as tabs/janelas abertas da aplicação sobre o resultado
    // A app principal ouve esta mensagem para actualizar a UI de status
    const clients = await self.clients.matchAll({
        includeUncontrolled: true,
        type: 'window'
    });

    clients.forEach(client => {
        client.postMessage({
            type:   'SYNC_COMPLETE',
            synced: results.synced.length,
            failed: results.failed.length
        });
    });

    // Se ainda há falhas por rede, re-lança para o browser agendar um novo retry
    if (results.failed.length > 0 && results.synced.length === 0) {
        throw new Error(`[SW] Sincronização falhou para todos os ${results.failed.length} registos. Retry agendado.`);
    }
}
