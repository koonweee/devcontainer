FROM node:22-alpine

WORKDIR /workspace

COPY package.json tsconfig.base.json vitest.workspace.ts ./
COPY apps ./apps
COPY packages ./packages

RUN npm install
RUN npm run gen:client
RUN npm run -w @devbox/web build

ENV PORT=4173
EXPOSE 4173

CMD ["node", "apps/web/build"]
