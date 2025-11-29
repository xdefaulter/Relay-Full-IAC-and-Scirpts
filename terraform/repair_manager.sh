#!/bin/bash
set -ex

echo "Starting repair..."

# Fetch Secret
export WS_SECRET=$(aws ssm get-parameter --name "/relay/ws_secret" --region "us-east-1" --with-decryption --query "Parameter.Value" --output text | tr -d '\n')

# 1. Update Code
echo "Pulling latest code..."
cd /opt/relay-cluster
sudo git config --global --add safe.directory /opt/relay-cluster
sudo git pull

# 2. Frontend
echo "Building Frontend..."
cd /opt/relay-cluster/frontend
sudo docker build -t relay-frontend .
sudo docker stop relay-frontend || true
sudo docker rm relay-frontend || true
sudo docker run -d \
  --name relay-frontend \
  --network relay-net \
  --memory="256m" \
  --cpus="0.5" \
  --restart=unless-stopped \
  -p 8081:80 \
  relay-frontend

# 2. Manager (Fixing health check port and removing 3000 mapping)
echo "Building Manager..."
cd /opt/relay-cluster/manager
sudo docker build -t relay-manager .
sudo docker stop relay-manager || true
sudo docker rm relay-manager || true
sudo docker run -d \
  --name relay-manager \
  --network relay-net \
  --memory="512m" \
  --cpus="1.0" \
  --restart=unless-stopped \
  --health-cmd="wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1" \
  --health-interval=30s \
  --health-timeout=10s \
  --health-retries=3 \
  -e WS_SECRET="$WS_SECRET" \
  -e CORS_ORIGIN="https://relay.amazon.com" \
  -p 8080:8080 \
  relay-manager

# 3. Nginx Config
echo "Configuring Nginx..."
sudo mkdir -p /etc/nginx/ssl
if [ ! -f /etc/nginx/ssl/nginx.key ]; then
    sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout /etc/nginx/ssl/nginx.key \
      -out /etc/nginx/ssl/nginx.crt \
      -subj "/C=CA/ST=Ontario/L=Toronto/O=RelayAuto/OU=IT/CN=relay-manager"
fi

sudo tee /etc/nginx/sites-available/default > /dev/null <<EOF
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

    # API (Fixed port to 8080)
    location /api/ {
        proxy_pass http://localhost:8080;
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

sudo systemctl restart nginx
echo "Repair complete!"
sudo docker ps
