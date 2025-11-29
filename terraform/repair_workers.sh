#!/bin/bash
set -e

WORKER_IPS=("3.86.185.94" "35.173.247.200" "52.87.99.91")
KEY_PATH="/Users/gursimranbhullar/.ssh/relay-cluster-key.pem"

for IP in "${WORKER_IPS[@]}"; do
    echo "--------------------------------------------------"
    echo "Updating Worker: $IP"
    echo "--------------------------------------------------"
    
    ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no ubuntu@$IP << 'EOF'
        set -e
        # Fetch Secret
        export WS_SECRET=$(aws ssm get-parameter --name "/relay/ws_secret" --region "us-east-1" --with-decryption --query "Parameter.Value" --output text)
        echo "Secret fetched. Length: ${#WS_SECRET}"
        
        echo "Pulling latest code..."
        cd /opt/relay-cluster
        sudo git pull
        
        echo "Rebuilding Worker..."
        cd worker
        sudo docker build -t relay-worker .
        
        echo "Restarting Container..."
        sudo docker stop relay-worker || true
        sudo docker rm relay-worker || true
        
        # ... (rest of logic)
        
            RUN_CMD=$(sudo grep -A 20 "docker run -d" /var/lib/cloud/instance/scripts/part-001 | head -n 16)
            # Fix invalid cap-add syntax (comma separated to multiple flags)
            RUN_CMD=${RUN_CMD//--cap-add=CHOWN,SETUID,SETGID/--cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID}
            
            # Inject PUPPETEER_EXECUTABLE_PATH
            RUN_CMD=${RUN_CMD//-e NODE_ID/-e PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable -e NODE_ID}
            
            echo "Found run command:"
            echo "$RUN_CMD"
            eval "sudo $RUN_CMD"
        
        echo "Worker $IP updated successfully!"
EOF
done

echo "All workers updated."
