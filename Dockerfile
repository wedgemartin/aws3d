FROM node:20-alpine AS build
ARG BASE_PATH=/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build --base $BASE_PATH

FROM node:20-alpine
RUN apk add --no-cache nginx
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
COPY bin/ ./bin/
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/http.d/default.conf

EXPOSE 8080

COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
