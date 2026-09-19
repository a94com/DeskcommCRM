-- 0231 · nome de sessão WAHA dentro do limite de 54 caracteres
--
-- ═══ O DEFEITO, ACHADO AO VIVO (2026-09-19) ══════════════════════════════
--
-- `fn_reserve_channel_connection` (0228/0230) monta o `waha_session_name` de
-- uma sessão NOVA assim:
--
--   'org_' || replace(p_org::text,'-','')      -- 32 hex
--          || '_' ||
--          replace(gen_random_uuid()::text,'-','')  -- 32 hex
--
-- = 4 + 32 + 1 + 32 = 69 caracteres. A validação do WAHA (WAHAValidationPipe,
-- `POST /api/sessions`) rejeita qualquer `name` acima de 54 com 400 Bad
-- Request — e SEMPRE rejeitava, para QUALQUER organização, desde que essa
-- validação existe na imagem `devlikeapro/waha:latest-2026.7.2` (a mesma tag
-- que a Aluggo já roda em produção). "Conectar novo WhatsApp" nunca
-- funcionou para uma sessão nova nesta versão do WAHA — só passava
-- despercebido porque os números já conectados foram pareados antes desta
-- validação existir, e ninguém tinha tentado conectar um NÚMERO NOVO desde
-- então.
--
-- O padrão CURTO já existe no próprio banco — é o que a sessão de ONBOARDING
-- usa (`'org_'||left(p_org::text,8)`, ver 0221/linha do onboarding acima) e
-- o que `lib/channels/onboarding-session.ts` já espera ao procurar por ela.
-- Esta migration só estende o MESMO estilo pra sessão comum, com um sufixo
-- aleatório mais curto pra garantir unicidade (`channel_sessions_waha_
-- session_name_unique`) sem estourar o limite.
--
-- ═══ Novo formato ════════════════════════════════════════════════════════
--
--   'org_' || 8 primeiros hex do org id || '_' || 16 hex aleatórios
--   = 4 + 8 + 1 + 16 = 29 caracteres — bem abaixo de 54, com folga para o
--   WAHA crescer o limite de novo sem quebrar isto de novo.
--
-- Não migra nomes já gravados (permanecem válidos e já pareados no WAHA;
-- reescrever um `waha_session_name` existente quebraria a sessão real). Só
-- muda o que a função gera DAQUI PRA FRENTE.
create or replace function public.fn_reserve_channel_connection(p_org uuid,p_key uuid,p_hash text,p_display_name text default null,p_onboarding boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt public.channel_connection_requests; channel public.channel_sessions; token uuid:=gen_random_uuid();
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org)
 then raise exception 'connection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'connection_mfa_required' using errcode='42501';end if;
 if p_key is null or p_hash is null or length(p_hash)<>64 or length(coalesce(p_display_name,''))>100 then
  raise exception 'connection_invalid_request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,2281));
 delete from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key
  and state='succeeded' and updated_at<now()-interval '24 hours';
 select * into receipt from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key for update;
 if found then
  if receipt.request_hash<>p_hash then raise exception 'idempotency_conflict' using errcode='22023';end if;
  if receipt.state='succeeded' then
   select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id;
   return jsonb_build_object('replay',true,'channel',to_jsonb(channel),'receipt_id',receipt.id);
  end if;
  if receipt.state='processing' and receipt.lease_until>now() then
   raise exception 'connection_in_progress' using errcode='55P03';end if;
  select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id for update;
  if not found then raise exception 'connection_reservation_missing' using errcode='P0002';end if;
 else
  if p_onboarding then
   select * into channel from public.channel_sessions where organization_id=p_org and provider='waha'
    and (metadata->>'onboarding'='true' or waha_session_name='org_'||left(p_org::text,8))
    order by created_at limit 1 for update;
  end if;
  if channel.id is null then
   insert into public.channel_sessions(organization_id,waha_session_name,display_name,engine,webhook_path_token,
     webhook_secret_encrypted,status,last_status_change_at,consecutive_health_fails,daily_message_limit,metadata)
   -- ANTES: 'org_'||replace(p_org::text,'-','')||'_'||replace(gen_random_uuid()::text,'-','')
   -- (69 chars, sempre acima do limite de 54 do WAHA — ver cabeçalho desta migration)
   values(p_org,'org_'||left(replace(p_org::text,'-',''),8)||'_'||left(replace(gen_random_uuid()::text,'-',''),16),p_display_name,'NOWEB',
     replace(gen_random_uuid()::text,'-',''),'\x00'::bytea,'STARTING',now(),0,250,
     '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'::jsonb
     || case when p_onboarding then '{"onboarding":true}'::jsonb else '{}'::jsonb end) returning * into channel;
  end if;
  if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
    and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
  insert into public.channel_connection_requests(organization_id,idempotency_key,request_hash,channel_session_id)
   values(p_org,p_key,p_hash,channel.id) returning * into receipt;
 end if;
 if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
   and id<>receipt.id and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
 update public.channel_connection_requests set state='processing',lease_token=token,lease_until=now()+interval '5 minutes',
  remote_created=false,updated_at=now() where organization_id=p_org and id=receipt.id;
 -- Não ressuscita antes da pós-condição remota. Arquivado permanece invisível
 -- até finish; falha conserva identidade e estado FAILED para reparo.
 update public.channel_sessions set status='STARTING',status_reason='connection_pending',last_status_change_at=now()
  where organization_id=p_org and id=channel.id returning * into channel;
 return jsonb_build_object('replay',false,'channel',to_jsonb(channel),'receipt_id',receipt.id,'lease_token',token);
end;
$$;
revoke all on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) from public,anon;
grant execute on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) to authenticated;
