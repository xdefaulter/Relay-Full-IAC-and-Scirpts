#!/bin/bash
set -eux

apt-get update
apt-get install -y docker.io git

systemctl enable docker
systemctl start docker

cd /opt
# Note: Replace YOUR_REPO_URL with the actual repository URL when deploying
git clone https://github.com/your-username/relay-cluster.git relay-cluster
cd relay-cluster/worker

docker build -t relay-worker .
docker run -d \
  --name relay-worker \
  --shm-size=1g \
  -v /opt/relay-cluster/extension:/opt/relay-extension \
  -e MANAGER_WS_URL=ws://${manager_host}:8080/agent \
  -e NODE_ID=${node_id} \
  relay-worker
