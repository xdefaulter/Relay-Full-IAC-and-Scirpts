#!/bin/bash
set -euxo pipefail

# Log all output
exec > >(tee -a /var/log/user-data.log)
exec 2>&1

echo "Starting worker node bootstrap for ${node_id}..."

apt-get update
# Install AWS CLI
apt-get install -y docker.io git awscli

systemctl enable docker
systemctl start docker

# Fetch secret from SSM
export WS_SECRET=$(aws ssm get-parameter --name "${ssm_parameter_name}" --region "${region}" --with-decryption --query "Parameter.Value" --output text)

cd /opt
# TODO: Update this to use private repository with authentication
# For now, using public repo - MAKE REPOSITORY PRIVATE BEFORE PRODUCTION
git clone https://github.com/xdefaulter/Relay-Full-IAC-and-Scirpts.git relay-cluster
cd relay-cluster/worker

docker build -t relay-worker .
docker run -d \
  --name relay-worker \
  --shm-size=1g \
  --memory="2g" \
  --cpus="2.0" \
  --pids-limit 200 \
  --security-opt=no-new-privileges:true \
  --cap-drop=ALL \
  --cap-add=CHOWN,SETUID,SETGID \
  --restart=unless-stopped \
  -v /opt/relay-cluster/extension:/opt/relay-extension:ro \
  -e MANAGER_WS_URL=wss://${manager_private_ip}:8080/agent \
  -e NODE_ID="${node_id}" \
  -e WS_SECRET="$WS_SECRET" \
  -e RELAY_USERNAME="${relay_username}" \
  -e RELAY_PASSWORD="${relay_password}" \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  relay-worker

echo "Worker node ${node_id} bootstrap complete!"
docker ps
