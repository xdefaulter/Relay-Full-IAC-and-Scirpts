#!/bin/bash
set -eux

apt-get update
apt-get install -y docker.io git

systemctl enable docker
systemctl start docker

cd /opt
# Note: Replace YOUR_REPO_URL with the actual repository URL when deploying
git clone https://github.com/xdefaulter/Relay-Full-IAC-and-Scirpts.git relay-cluster
cd relay-cluster

# Create network first
docker network create relay-net

# Build & run manager
cd manager
docker build -t relay-manager .
docker run -d --name relay-manager --network relay-net -p 3000:3000 -p 8080:8080 relay-manager

# Build & run frontend
cd ../frontend
docker build -t relay-frontend .
docker run -d --name relay-frontend --network relay-net -p 80:80 relay-frontend
