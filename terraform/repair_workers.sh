#!/bin/bash
set -e

WORKER_IPS=("3.86.185.94" "35.173.247.200" "52.87.99.91")
KEY_PATH="/Users/gursimranbhullar/.ssh/relay-cluster-key.pem"

for IP in "${WORKER_IPS[@]}"; do
    echo "--------------------------------------------------"
    echo "Updating Worker: $IP"
    echo "--------------------------------------------------"
    
    # Pass local env vars to remote session
    # Read cookies if file exists
  COOKIES_B64=""
  if [ -f "../Untitled-1.json" ]; then
      echo "Found cookies file, encoding..."
      COOKIES_B64=$(base64 < "../Untitled-1.json" | tr -d '\n')
  fi

  ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no ubuntu@$IP "
    set -e
    # Pass local env vars to remote session
    export MANAGER_WS_URL=\"$MANAGER_WS_URL\"
    export RELAY_USERNAME=\"$RELAY_USERNAME\"
    export RELAY_PASSWORD=\"$RELAY_PASSWORD\"
    export RELAY_COOKIES_B64=\"$COOKIES_B64\"
    
    # Fetch Secret
    export WS_SECRET=\$(aws ssm get-parameter --name \"/relay/ws_secret\" --region \"us-east-1\" --with-decryption --query \"Parameter.Value\" --output text)
    echo \"Secret fetched. Length: \${#WS_SECRET}\"
    
    # 2. Pull latest code
    echo \"Pulling latest code...\"
    cd /opt/relay-cluster
    sudo git config --global --add safe.directory /opt/relay-cluster
    sudo git pull
    
    # 3. Rebuild Worker Image
    echo \"Rebuilding Worker...\"
    cd worker
    sudo docker build -t relay-worker .
    
    echo \"Restarting Container...\"
    sudo docker stop relay-worker || true
    sudo docker rm relay-worker || true
    
    # Extract run command from user_data (or use hardcoded)
    # We will use a constructed command to ensure cookies are passed
    
    sudo docker run -d \\
      --name relay-worker \\
      --shm-size=1g \\
      --memory=\"2g\" \\
      --cpus=\"2.0\" \\
      --pids-limit 200 \\
      --security-opt=no-new-privileges:true \\
      --cap-drop=ALL \\
      --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID \\
      --restart=unless-stopped \\
      -v /opt/relay-cluster/extension:/opt/relay-extension:ro \\
      -e MANAGER_WS_URL=\"\$MANAGER_WS_URL\" \\
      -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \\
      -e RELAY_USERNAME=\"\$RELAY_USERNAME\" \\
      -e RELAY_PASSWORD=\"\$RELAY_PASSWORD\" \\
      -e RELAY_COOKIES_B64=\"\$RELAY_COOKIES_B64\" \\
      -e NODE_ID=\"worker-$i\" \\
      -e WS_SECRET=\"\$WS_SECRET\" \\
      -e NODE_TLS_REJECT_UNAUTHORIZED=0 \\
      relay-worker
    
    echo \"Worker $IP updated successfully!\"
  "
done

echo "All workers updated."
