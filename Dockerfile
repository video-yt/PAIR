FROM node:20-bullseye

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY . .

EXPOSE 5000

CMD ["node", "index.js"]
