#!/bin/sh
# Regenerate the runtime config the editor reads before boot. Runs under the
# nginx image's entrypoint (which then starts nginx). SEAM_CLOUD_URL is the
# *public* base URL of the Seam Cloud instance the browser will reach.
set -e
cat > /usr/share/nginx/html/config.js <<EOF
window.__SEAM_CLOUD_URL__ = "${SEAM_CLOUD_URL:-}";
EOF
