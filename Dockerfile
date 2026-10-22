FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY main.js ./

USER node
EXPOSE 8080
CMD ["node", "main.js"]
