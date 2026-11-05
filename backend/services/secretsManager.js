// AWS Secrets Manager integration using AWS SDK v3
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const config = require('../config');

/**
 * Retrieve a secret from AWS Secrets Manager
 *
 * @param {string} secretName - Name/ARN of the secret
 * @param {string} region - AWS region name
 * @param {string} secretType - Type of secret - 'plain_text' or 'json'
 * @returns {Promise<string|object>} - The secret value as either a string or object
 */
async function getSecret(secretName, region = config.aws.region, secretType = 'plain_text') {
  console.log(`Attempting to retrieve secret: ${secretName} from region: ${region}`);

  try {
    // Create AWS Secrets Manager client using default credentials chain
    // Cross-account role should only be used for Bedrock calls
    console.log('Using default credentials chain for Secrets Manager');
    const client = new SecretsManagerClient({ region });

    console.log('AWS Secrets Manager client created, retrieving secret...');
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    console.log(`Successfully retrieved secret: ${secretName}`);

    if (!response.SecretString) {
      throw new Error(`Secret ${secretName} has no value`);
    }
    
    const secret = response.SecretString;
    
    if (secretType.toLowerCase() === 'json') {
      try {
        return JSON.parse(secret);
      } catch (e) {
        console.error(`Failed to parse secret as JSON: ${e.name}`); // never the message, it quotes the value
        throw e;
      }
    }
    
    return secret;
  } catch (error) {
    console.error(`Error retrieving secret ${secretName}: ${error.message}`);
    throw error;
  }
}

/**
 * Retrieve additional secrets from ADDITIONAL_SECRETS environment variable
 * Expected format: JSON string containing key-value pairs, or plain string
 * 
 * @returns {object|string} - Parsed additional secrets object or plain string
 * @throws {Error} - If ADDITIONAL_SECRETS environment variable is not set
 */
async function getAdditionalSecrets() {
  const additionalSecretsEnv = process.env.ADDITIONAL_SECRETS;
  
  if (!additionalSecretsEnv) {
    throw new Error('ADDITIONAL_SECRETS environment variable is not set');
  }
  
  // Try multiple parsing approaches
  let secret = additionalSecretsEnv.trim();
  
  // First try to parse as JSON directly
  try {
    return JSON.parse(secret);
  } catch (jsonError) {
    console.log(`ADDITIONAL_SECRETS direct JSON parse failed: ${jsonError.name}`);
  }
  
  // If it looks like it might be a secret name, try to retrieve it from AWS Secrets Manager
  if (secret.length < 100 && !secret.includes('{') && !secret.includes('"')) {
    try {
      console.log(`Treating ADDITIONAL_SECRETS as secret name: ${secret}`);
      const secretValue = await getSecret(secret, config.aws.region, 'json');
      if (typeof secretValue === 'object') {
        return secretValue;
      }
      // If it's a string, try to parse it as JSON
      if (typeof secretValue === 'string') {
        try {
          return JSON.parse(secretValue);
        } catch (parseError) {
          console.log(`Failed to parse retrieved secret as JSON: ${parseError.name}`);
        }
      }
    } catch (secretError) {
      console.log(`Failed to retrieve as AWS secret: ${secretError.name}`);
    }
  }
  
  // Try to fix common JSON formatting issues
  try {
    // Remove any escape characters and quotes around the entire string
    let cleaned = secret.replace(/^["']|["']$/g, '');
    // Try to unescape if it's double-escaped
    if (cleaned.includes('\\"')) {
      cleaned = cleaned.replace(/\\"/g, '"');
    }
    return JSON.parse(cleaned);
  } catch (cleanError) {
    console.log(`Cleaned JSON parse failed: ${cleanError.name}`);
  }
  
  console.log(`ADDITIONAL_SECRETS is not valid JSON, treating as plain string. Length: ${secret.length}`);
  // If all parsing attempts fail, return as plain string
  return secret;
}

module.exports = {
  getSecret,
  getAdditionalSecrets
};
