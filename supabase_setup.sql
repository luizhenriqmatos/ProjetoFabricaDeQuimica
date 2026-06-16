-- =============================================================================
-- CHEMREPORT PRO — Supabase Schema & Row Level Security (RLS)
-- Execute este script no SQL Editor do seu projecto Supabase
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABELA PRINCIPAL
-- Armazena rascunhos e relatórios finalizados enviados pelos operadores.
-- A coluna form_data usa JSONB para flexibilidade de schema sem migrações.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.relatorios_quimica (
    id          UUID         PRIMARY KEY,                     -- gerado pelo cliente (generateUUID)
    username    TEXT         NOT NULL,                        -- email do utilizador autenticado
    status      TEXT         NOT NULL DEFAULT 'rascunho'      -- 'rascunho' | 'finalizado'
                             CHECK (status IN ('rascunho', 'finalizado')),
    form_data   JSONB        NOT NULL DEFAULT '{}',           -- dados do formulário (flexível)
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()           -- timestamp de última modificação
);

-- Índices para as queries mais comuns (filtragem por utilizador e status)
CREATE INDEX IF NOT EXISTS idx_relatorios_username   ON public.relatorios_quimica (username);
CREATE INDEX IF NOT EXISTS idx_relatorios_status     ON public.relatorios_quimica (status);
CREATE INDEX IF NOT EXISTS idx_relatorios_updated_at ON public.relatorios_quimica (updated_at DESC);

-- -----------------------------------------------------------------------------
-- 2. ACTIVAR ROW LEVEL SECURITY
-- Sem RLS, qualquer utilizador autenticado poderia ler/escrever todos os dados.
-- Com RLS, cada política define exactamente quem pode fazer o quê.
-- -----------------------------------------------------------------------------
ALTER TABLE public.relatorios_quimica ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3. POLÍTICAS RLS PARA OPERADORES
-- Princípio: o operador só vê e escreve os seus próprios registos.
-- auth.email() retorna o email do utilizador autenticado na sessão actual.
-- -----------------------------------------------------------------------------

-- Operador pode LER apenas os seus próprios relatórios
CREATE POLICY "operador_select_own"
    ON public.relatorios_quimica
    FOR SELECT
    USING ( username = auth.email() );

-- Operador pode INSERIR relatórios apenas com o seu próprio username
-- (impede que um operador envie dados em nome de outro)
CREATE POLICY "operador_insert_own"
    ON public.relatorios_quimica
    FOR INSERT
    WITH CHECK ( username = auth.email() );

-- Operador pode ACTUALIZAR apenas os seus próprios registos
-- (necessário para o UPSERT do auto-save de rascunhos)
CREATE POLICY "operador_update_own"
    ON public.relatorios_quimica
    FOR UPDATE
    USING  ( username = auth.email() )
    WITH CHECK ( username = auth.email() );

-- Operador NÃO pode apagar relatórios (auditoria — registos são imutáveis)
-- (sem política DELETE = nenhum utilizador comum pode apagar)

-- -----------------------------------------------------------------------------
-- 4. POLÍTICAS RLS PARA SUPERVISORES
-- Supervisores têm role='supervisor' nos user_metadata do Supabase Auth.
-- A função abaixo lê os metadados do JWT para verificar a role.
-- -----------------------------------------------------------------------------

-- Função auxiliar: extrai a role dos metadados do utilizador autenticado
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT AS $$
    SELECT COALESCE(
        auth.jwt() -> 'user_metadata' ->> 'role',
        ''
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Supervisor pode LER todos os relatórios finalizados (painel de supervisão)
CREATE POLICY "supervisor_select_all_finalized"
    ON public.relatorios_quimica
    FOR SELECT
    USING (
        public.get_user_role() = 'supervisor'
        AND status = 'finalizado'
    );

-- -----------------------------------------------------------------------------
-- 5. COMO DEFINIR A ROLE 'supervisor' NO SUPABASE AUTH
-- No painel Supabase: Authentication > Users > seleccionar utilizador > Edit
-- Em "User Metadata" adicionar: { "role": "supervisor" }
--
-- Ou via SQL (substitua o UUID pelo id real do utilizador):
-- UPDATE auth.users
-- SET raw_user_meta_data = raw_user_meta_data || '{"role": "supervisor"}'
-- WHERE email = 'supervisor@empresa.com';
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 6. VERIFICAÇÃO — listar políticas activas
-- -----------------------------------------------------------------------------
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
-- FROM pg_policies
-- WHERE tablename = 'relatorios_quimica';
