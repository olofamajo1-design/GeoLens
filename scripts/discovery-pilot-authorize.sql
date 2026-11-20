\set ON_ERROR_STOP on
begin;

-- Run on disposable local Postgres after verifying the route and terms.
-- No existing operator role is changed by this script.
select u.id as verified_operator
from auth.users u join app.user_roles ur on ur.user_id=u.id
join app.roles r on r.id=ur.role_id
where u.id=:'operator_id'::uuid and r.code='ingestion_operator' and ur.revoked_at is null
\gset

select e.id as pilot_endpoint, p.terms_reference, p.attribution
from news.discovery_pilot_sources p join news.discovery_endpoints e on e.locator=p.locator and e.adapter=p.adapter
where p.adapter=:'source_adapter' and not e.fixture
for update of e
\gset

select 1 as verified_deadline where isfinite(:'licensed_until'::timestamptz)
  and isfinite(:'retention_until'::timestamptz)
  and :'licensed_until'::timestamptz>statement_timestamp()
  and :'retention_until'::timestamptz>=:'licensed_until'::timestamptz
\gset

insert into ai_ops.discovery_pilot_operators(user_id,expires_at)
values(:'verified_operator'::uuid,:'licensed_until'::timestamptz)
on conflict(user_id) do update set expires_at=greatest(ai_ops.discovery_pilot_operators.expires_at,excluded.expires_at);

insert into news.acquisition_licences(endpoint_id,terms_reference,attribution,fields,valid_from,valid_until,retention_until)
values(:'pilot_endpoint'::uuid,:'terms_reference',:'attribution',array['metadata'],statement_timestamp(),
  :'licensed_until'::timestamptz,:'retention_until'::timestamptz);

select governance.log_event('discovery.pilot_operator_granted',:'verified_operator'::uuid,
  jsonb_build_object('endpoint_id',:'pilot_endpoint'::uuid,'valid_until',:'licensed_until'::timestamptz));

update news.discovery_endpoints set enabled=true where id=:'pilot_endpoint'::uuid;
commit;
