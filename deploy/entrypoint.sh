#!/bin/sh
# Start the AWS proxy backend
node bin/aws3d.js serve --host 0.0.0.0 --read-only --region ${AWS_REGION:-us-east-1} ${ROLE_ARN:+--role-arn $ROLE_ARN} &

# Start nginx to serve frontend + proxy API
nginx -g 'daemon off;'
