FROM node:22-alpine

WORKDIR /workspace

COPY package.json tsconfig.base.json vitest.workspace.ts ./
COPY apps ./apps
COPY packages ./packages

RUN npm install
RUN npm run gen:client

EXPOSE 3000

CMD ["npm", "run", "-w", "@devbox/api", "start"]
