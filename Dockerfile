FROM node:20-slim

WORKDIR /app
COPY index.js package.json ./

ENV MCP_TRANSPORT=http
ENV PORT=8000
EXPOSE 8000

USER node

CMD ["node", "index.js", "--http"]
