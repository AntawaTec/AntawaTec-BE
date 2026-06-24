-- =============================================================================
-- 0020_user_role_technician.sql
-- Agrega el rol 'technician' al enum public.user_role.
--
-- VA SOLO en su propia migración: Supabase envuelve cada archivo en una tx y un
-- valor de enum recién agregado NO puede referenciarse en la misma tx que lo crea
-- (mismo motivo que 0016). El constraint de profiles y las políticas que usan
-- 'technician' viven en 0021/0022, que corren en tx posteriores.
-- =============================================================================
alter type public.user_role add value if not exists 'technician';
