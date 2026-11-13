#!/usr/bin/env bash
# Upgrade ARK Work only. Keep production .env, volumes and the shared proxy.
set -euo pipefail
project_dir="${1:-/opt/mcp-ark/ARK-work}"
release_ref="feat/facturas-proveedores-y-escritura"
compose_file="$project_dir/compose.vps.yaml"
override="/root/ark-work-full.override.yaml"
rollback="/root/ark-work-full.rollback.yaml"
test -f "$compose_file" || { echo "No se encuentra $compose_file" >&2; exit 1; }
command -v docker >/dev/null
command -v git >/dev/null
command -v python3 >/dev/null
git -C "$project_dir" fetch origin "$release_ref"
release_sha="$(git -C "$project_dir" rev-parse FETCH_HEAD)"
release_dir="${project_dir}-release-${release_sha:0:12}"
if test -e "$release_dir"; then
  test "$(git -C "$release_dir" rev-parse HEAD)" = "$release_sha"
  test -z "$(git -C "$release_dir" status --porcelain)" || { echo 'El directorio de versión contiene cambios; revisar antes de continuar.' >&2; exit 1; }
else
  git -C "$project_dir" worktree add --detach "$release_dir" "$release_sha"
fi
compose_base=(docker compose --project-name ark-work --project-directory "$project_dir" -f "$compose_file")
container_id="$("${compose_base[@]}" ps -q ark-work)"
test -n "$container_id" || { echo 'No se encuentra el contenedor actual de ark-work; revisar el proyecto Compose.' >&2; exit 1; }
previous_image="$(docker inspect --format '{{.Image}}' "$container_id")"
previous_writes="$(docker exec "$container_id" sh -c 'printenv WORK_ENABLE_WRITES || true')"
# Store the prior runtime image/flag for rollback, without copying credentials.
python3 - "$override" "$rollback" "$release_dir" "$previous_image" "$previous_writes" <<'PY'
import json,os,sys
override,rollback,context,image,writes=sys.argv[1:]
for path,body in [(override,{'services':{'ark-work':{'build':{'context':context},'environment':{'WORK_ENABLE_WRITES':'true'}}}}),
                  (rollback,{'services':{'ark-work':{'image':image,'environment':{'WORK_ENABLE_WRITES':writes or 'false'}}}})]:
    if os.path.exists(path):
        from datetime import datetime,timezone
        backup=path+'.'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.bak'
        os.rename(path,backup)
    with open(path,'w') as f: json.dump(body,f,indent=2); f.write('\n')
    os.chmod(path,0o600)
PY
compose=("${compose_base[@]}" -f "$override")
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-deps --build ark-work
test "$("${compose[@]}" exec -T ark-work printenv WORK_ENABLE_WRITES)" = true
# Network may still be starting. The health response must identify ARK Work.
for attempt in 1 2 3 4 5; do
  if "${compose[@]}" exec -T ark-work node --input-type=module -e \
    'const r=await fetch("http://127.0.0.1:8787/healthz",{headers:{Host:new URL(process.env.PUBLIC_URL).host}});if(!r.ok)process.exit(1);const b=await r.json();if(b.service!=="ark-work"||b.status!=="ok"||b.version!=="0.2.0")process.exit(1);'; then
    echo 'ARK Work actualizado. Escritura habilitada; cada conexión necesita autorización OAuth de escritura.'
    echo "Usar siempre el override persistente $override en futuras recreaciones."
    echo "Si hace falta revertir: docker compose --project-name ark-work --project-directory $project_dir -f $compose_file -f $rollback up -d --no-deps --no-build ark-work"
    exit 0
  fi
  sleep 2
done
echo "El servicio no ha superado la comprobación de salud. Revisar registros; rollback disponible en $rollback. No ejecutar escrituras de prueba en producción." >&2
exit 1
