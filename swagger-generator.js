const swaggerJsdoc = require('swagger-jsdoc');
const fs = require('fs');
const path = require('path');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Cardano Governance API',
      version: '1.0.0',
      description: 'API for fetching Cardano governance proposals from Blockfrost',
      contact: {
        name: 'API Support',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server',
      },
    ],
  },
  apis: [
    './src/routes/**/*.ts',
    './src/schemas/**/*.ts'
  ],
};

const swaggerSpec = swaggerJsdoc(options);

// Create docs directory if it doesn't exist
const docsDir = path.join(__dirname, 'docs');
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}

// Write swagger.json file
const outputPath = path.join(docsDir, 'swagger.json');
fs.writeFileSync(outputPath, JSON.stringify(swaggerSpec, null, 2));

console.log('✅ Swagger spec generated at ./docs/swagger.json');
console.log('📝 Routes scanned:', options.apis);
console.log('🔗 View at: http://localhost:3000/api-docs');
