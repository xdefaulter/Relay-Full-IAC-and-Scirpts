#!/bin/bash
set -euxo pipefail

# Log all output
exec > >(tee -a /var/log/user-data.log)
exec 2>&1

echo "Starting manager node bootstrap..."

apt-get update
# Install AWS CLI and Nginx
apt-get install -y docker.io git curl awscli nginx

systemctl enable docker
systemctl start docker

# Fetch secret from SSM
export WS_SECRET=$(aws ssm get-parameter --name "${ssm_parameter_name}" --region "${region}" --with-decryption --query "Parameter.Value" --output text)

cd /opt
# TODO: Update this to use private repository with authentication
# For now, using public repo - MAKE REPOSITORY PRIVATE BEFORE PRODUCTION
git clone https://github.com/xdefaulter/Relay-Full-IAC-and-Scirpts.git relay-cluster
cd relay-cluster

# Create network first
docker network create relay-net || true

# Build & run manager with security hardening
cd manager
docker build -t relay-manager .
docker run -d \
  --name relay-manager \
  --network relay-net \
  --memory="512m" \
  --cpus="1.0" \
  --pids-limit 100 \
  --security-opt=no-new-privileges:true \
  --restart=unless-stopped \
  --health-cmd="curl -f http://localhost:3000/health || exit 1" \
  --health-interval=30s \
  --health-timeout=10s \
  --health-retries=3 \
  -e WS_SECRET="$WS_SECRET" \
  -e CORS_ORIGIN="https://relay.amazon.com" \
  -p 3000:3000 \
  -p 8080:8080 \
  relay-manager

# Build & run frontend with security hardening
cd ../frontend
docker build -t relay-frontend .
docker run -d \
  --name relay-frontend \
  --network relay-net \
  --memory="256m" \
  --cpus="0.5" \
  --pids-limit 50 \
  --read-only \
  --tmpfs /tmp \
  --tmpfs /var/cache/nginx \
  --tmpfs /var/run \
  --security-opt=no-new-privileges:true \
  --restart=unless-stopped \
  -p 8081:80 \
  relay-frontend

# Configure Nginx as Reverse Proxy with Self-Signed SSL
# Generate self-signed cert
mkdir -p /etc/nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/nginx.key \
  -out /etc/nginx/ssl/nginx.crt \
  -subj "/C=CA/ST=Ontario/L=Toronto/O=RelayAuto/OU=IT/CN=relay-manager"

# Write Nginx config
cat > /etc/nginx/sites-available/default <<EOF
server {
    listen 80 default_server;
    server_name _;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl default_server;
    server_name _;

    ssl_certificate /etc/nginx/ssl/nginx.crt;
    ssl_certificate_key /etc/nginx/ssl/nginx.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Frontend
    location / {
        proxy_pass http://localhost:8081;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # API
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # WebSocket
    location /agent {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }
}
EOF

# Restart Nginx
systemctl restart nginx

echo "Manager node bootstrap complete!"
docker ps

