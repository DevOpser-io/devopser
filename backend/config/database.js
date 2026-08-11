/**
 * Database configuration for Sequelize
 * This file is used by both the application and Sequelize CLI
 */
const path = require('path');
const fs = require('fs');
// Import AWS SDK v3 modules
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Log the current environment
console.log('==================================================');

// NODE_ENV is authoritative. Only downgrade from production when an explicit
// opt-in flag is set (never inferred from the orchestrator var).
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_PRODUCTION_OVERRIDE === 'true') {
  console.warn('DATABASE CONFIG: ALLOW_LOCAL_PRODUCTION_OVERRIDE=true, downgrading NODE_ENV to development');
  process.env.NODE_ENV = 'development';
}

console.log(`DATABASE CONFIG: Current NODE_ENV is set to: ${process.env.NODE_ENV || 'undefined (defaulting to development)'}`);
console.log(`DATABASE CONFIG: Running in ${require.main === module ? 'Sequelize CLI mode' : 'Application mode'}`);
console.log('==================================================');

// Load environment variables from .env file if not in production
if (process.env.NODE_ENV !== 'production') {
  console.log('DATABASE CONFIG: Loading environment variables from .env file');
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
}

/**
 * Retrieve a secret from AWS Secrets Manager
 * @param {string} secretName - Name of the secret to retrieve
 * @param {string} region - AWS region
 * @returns {Promise<string>} - The secret value
 */
async function getSecret(secretName, region = process.env.REGION || 'us-east-1') {
  if (!secretName) {
    console.error('Secret name not provided');
    return null;
  }
  
  console.log(`Retrieving secret: ${secretName} from region: ${region}`);
  
  try {
    // Create a Secrets Manager client
    const client = new SecretsManagerClient({ region });
    
    // Create the command to get the secret value
    const command = new GetSecretValueCommand({ SecretId: secretName });
    
    // Execute the command
    const response = await client.send(command);
    
    if (response.SecretString) {
      console.log(`Successfully retrieved secret: ${secretName}`);
      return response.SecretString;
    } else {
      console.error(`Secret ${secretName} has no string value`);
      return null;
    }
  } catch (error) {
    console.error(`Error retrieving secret ${secretName}: ${error.message}`);
    if (error.name === 'ResourceNotFoundException') {
      console.error(`Secret ${secretName} not found`);
    } else if (error.name === 'AccessDeniedException') {
      console.error(`Access denied to secret ${secretName}`);
    }
    return null;
  }
}

// Base configuration for all environments
const config = {
  development: {
    username: process.env.POSTGRES_USER || 'devuser',
    password: process.env.POSTGRES_PASSWORD || 'password',
    database: process.env.POSTGRES_DB || 'devdb',
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    dialect: 'postgres',
    logging: process.env.DATABASE_LOGGING === 'true'
  },
  test: {
    username: process.env.POSTGRES_USER || 'devuser',
    password: process.env.POSTGRES_PASSWORD || 'password',
    database: process.env.POSTGRES_DB || 'devdb',
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    dialect: 'postgres',
    logging: false
  },
  production: {
    // In production, credentials are loaded from AWS Secrets Manager
    username: null,   // Will be updated from AWS Secrets Manager
    password: null,   // Will be updated from AWS Secrets Manager
    database: null,   // Will be updated from AWS Secrets Manager
    host: null,       // Will be updated from AWS Secrets Manager
    port: 5432,       // Will be updated from AWS Secrets Manager
    dialect: 'postgres',
    logging: false,
    dialectOptions: process.env.DB_REQUIRE_SSL === 'true' ? {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    } : {}
  }
};

// In production, we need to load secrets from AWS Secrets Manager
if (process.env.NODE_ENV === 'production') {
  // Check if this is being run by Sequelize CLI
  if (require.main === module) {
    console.log('This file is being run directly by Sequelize CLI');
    console.log('Creating a configuration file with credentials');
    
    try {
      // For Sequelize CLI, we need to use a synchronous approach since it doesn't support async config
      // We'll use the AWS CLI via execSync to retrieve secrets synchronously
      const { execSync } = require('child_process');
      const region = process.env.REGION || 'us-east-1';
      
      // Function to get a secret synchronously using AWS CLI
      // This doesn't use the AWS SDK directly since we need synchronous operation
      const getSecretSync = (secretName) => {
        if (!secretName) {
          console.warn(`Secret name not provided for getSecretSync`);
          return null;
        }
        try {
          console.log(`Attempting to retrieve secret ${secretName} using AWS CLI`);
          const command = `aws secretsmanager get-secret-value --secret-id "${secretName}" --region "${region}" --query SecretString --output text`;
          const result = execSync(command).toString().trim();
          console.log(`Successfully retrieved secret ${secretName} synchronously`);
          return result;
        } catch (error) {
          console.error(`Error retrieving secret ${secretName} synchronously: ${error.message}`);
          // Log more details about the error to help diagnose issues
          if (error.stderr) {
            console.error(`AWS CLI stderr: ${error.stderr.toString()}`);
          }
          return null;
        }
      };
      
      // Check if required environment variables are set
      console.log('Checking for required environment variables:');
      console.log(`DB_USER_SECRET_NAME: ${process.env.DB_USER_SECRET_NAME ? 'Set' : 'Not set'}`);
      console.log(`DB_PASSWORD_SECRET_NAME: ${process.env.DB_PASSWORD_SECRET_NAME ? 'Set' : 'Not set'}`);
      console.log(`DB_NAME_SECRET_NAME: ${process.env.DB_NAME_SECRET_NAME ? 'Set' : 'Not set'}`);
      console.log(`DB_HOST_SECRET_NAME: ${process.env.DB_HOST_SECRET_NAME ? 'Set' : 'Not set'}`);
      console.log(`DB_PORT_SECRET_NAME: ${process.env.DB_PORT_SECRET_NAME ? 'Set' : 'Not set'}`);
      
      // Get DB credentials from AWS Secrets Manager
      if (process.env.DB_USER_SECRET_NAME) {
        const dbUser = getSecretSync(process.env.DB_USER_SECRET_NAME);
        if (dbUser) {
          config.production.username = dbUser;
          console.log(`Updated username to value from secret ${process.env.DB_USER_SECRET_NAME}`);
        } else {
          console.warn(`Failed to get username from secret ${process.env.DB_USER_SECRET_NAME}, using default: ${config.production.username}`);
        }
      } else {
        console.warn('DB_USER_SECRET_NAME not set, using default username');
      }
      
      if (process.env.DB_PASSWORD_SECRET_NAME) {
        const dbPassword = getSecretSync(process.env.DB_PASSWORD_SECRET_NAME);
        if (dbPassword) {
          config.production.password = dbPassword;
          console.log(`Updated password from secret ${process.env.DB_PASSWORD_SECRET_NAME}`);
        } else {
          console.warn(`Failed to get password from secret ${process.env.DB_PASSWORD_SECRET_NAME}, using default`);
        }
      } else {
        console.warn('DB_PASSWORD_SECRET_NAME not set, using default password');
      }
      
      if (process.env.DB_NAME_SECRET_NAME) {
        const dbName = getSecretSync(process.env.DB_NAME_SECRET_NAME);
        if (dbName) {
          config.production.database = dbName;
          console.log(`Updated database name to ${config.production.database} from secret ${process.env.DB_NAME_SECRET_NAME}`);
        } else {
          console.warn(`Failed to get database name from secret ${process.env.DB_NAME_SECRET_NAME}, using default: ${config.production.database}`);
        }
      } else {
        console.warn('DB_NAME_SECRET_NAME not set, using default database name');
      }
      
      if (process.env.DB_HOST_SECRET_NAME) {
        const dbHost = getSecretSync(process.env.DB_HOST_SECRET_NAME);
        if (dbHost) {
          config.production.host = dbHost;
          console.log(`Updated host to ${config.production.host} from secret ${process.env.DB_HOST_SECRET_NAME}`);
        } else {
          console.warn(`Failed to get host from secret ${process.env.DB_HOST_SECRET_NAME}, using default: ${config.production.host}`);
        }
      } else {
        console.warn('DB_HOST_SECRET_NAME not set, using default host');
      }
      
      if (process.env.DB_PORT_SECRET_NAME) {
        const dbPort = getSecretSync(process.env.DB_PORT_SECRET_NAME);
        if (dbPort) {
          config.production.port = parseInt(dbPort, 10);
          console.log(`Updated port to ${config.production.port} from secret ${process.env.DB_PORT_SECRET_NAME}`);
        } else {
          console.warn(`Failed to get port from secret ${process.env.DB_PORT_SECRET_NAME}, using default: ${config.production.port}`);
        }
      } else {
        console.warn('DB_PORT_SECRET_NAME not set, using default port');
      }
      
      // Create a config.json file that Sequelize CLI can find
      const configJsonPath = path.join(__dirname, 'config.json');
      fs.writeFileSync(configJsonPath, JSON.stringify(config, null, 2));
      
      console.log(`Created config.json at ${configJsonPath}`);
      console.log('Database configuration for Sequelize CLI:', {
        username: '****', // Mask sensitive data
        database: config.production.database,
        host: config.production.host,
        port: config.production.port,
        dialect: config.production.dialect,
        dialectOptions: config.production.dialectOptions
      });
      
      // Also create a backup copy in case .sequelizerc is not found
      const backupConfigPath = path.join(__dirname, '..', 'config', 'config.json');
      try {
        // Ensure the directory exists
        fs.mkdirSync(path.dirname(backupConfigPath), { recursive: true });
        fs.writeFileSync(backupConfigPath, JSON.stringify(config, null, 2));
        console.log(`Created backup config.json at ${backupConfigPath}`);
      } catch (err) {
        console.warn(`Could not create backup config.json: ${err.message}`);
      }
      
      // Return the config directly
      console.log('Returning updated configuration to Sequelize CLI');
      module.exports = config;
      return;
    } catch (error) {
      console.error('Error creating temporary configuration file:', error);
      // Don't exit, continue with default config
      console.warn('Continuing with default configuration due to error');
    }
  } else {
    // This is being run by the application, not Sequelize CLI
    // We can use asynchronous code here
    console.log('Loading database credentials from AWS Secrets Manager');
    
    // Function to load all secrets asynchronously
    const loadDatabaseCredentials = async () => {
      try {
        // Check if required environment variables are set
        console.log('Checking for required environment variables:');
        console.log(`DB_USER_SECRET_NAME: ${process.env.DB_USER_SECRET_NAME ? 'Set' : 'Not set'}`);
        console.log(`DB_PASSWORD_SECRET_NAME: ${process.env.DB_PASSWORD_SECRET_NAME ? 'Set' : 'Not set'}`);
        console.log(`DB_NAME_SECRET_NAME: ${process.env.DB_NAME_SECRET_NAME ? 'Set' : 'Not set'}`);
        console.log(`DB_HOST_SECRET_NAME: ${process.env.DB_HOST_SECRET_NAME ? 'Set' : 'Not set'}`);
        console.log(`DB_PORT_SECRET_NAME: ${process.env.DB_PORT_SECRET_NAME ? 'Set' : 'Not set'}`);
        
        // Get DB credentials from AWS Secrets Manager
        if (process.env.DB_USER_SECRET_NAME) {
          const dbUser = await getSecret(process.env.DB_USER_SECRET_NAME);
          if (dbUser) {
            config.production.username = dbUser;
            console.log(`Updated username from secret ${process.env.DB_USER_SECRET_NAME}`);
          } else {
            console.warn(`Failed to get username from secret ${process.env.DB_USER_SECRET_NAME}, using default: ${config.production.username}`);
          }
        } else {
          console.warn('DB_USER_SECRET_NAME not set, using default username');
        }
        
        if (process.env.DB_PASSWORD_SECRET_NAME) {
          const dbPassword = await getSecret(process.env.DB_PASSWORD_SECRET_NAME);
          if (dbPassword) {
            config.production.password = dbPassword;
            console.log(`Updated password from secret ${process.env.DB_PASSWORD_SECRET_NAME}`);
          } else {
            console.warn(`Failed to get password from secret ${process.env.DB_PASSWORD_SECRET_NAME}, using default`);
          }
        } else {
          console.warn('DB_PASSWORD_SECRET_NAME not set, using default password');
        }
        
        if (process.env.DB_NAME_SECRET_NAME) {
          const dbName = await getSecret(process.env.DB_NAME_SECRET_NAME);
          if (dbName) {
            config.production.database = dbName;
            console.log(`Updated database name to ${config.production.database} from secret ${process.env.DB_NAME_SECRET_NAME}`);
          } else {
            console.warn(`Failed to get database name from secret ${process.env.DB_NAME_SECRET_NAME}, using default: ${config.production.database}`);
          }
        } else {
          console.warn('DB_NAME_SECRET_NAME not set, using default database name');
        }
        
        if (process.env.DB_HOST_SECRET_NAME) {
          const dbHost = await getSecret(process.env.DB_HOST_SECRET_NAME);
          if (dbHost) {
            config.production.host = dbHost;
            console.log(`Updated host to ${config.production.host} from secret ${process.env.DB_HOST_SECRET_NAME}`);
          } else {
            console.warn(`Failed to get host from secret ${process.env.DB_HOST_SECRET_NAME}, using default: ${config.production.host}`);
          }
        } else {
          console.warn('DB_HOST_SECRET_NAME not set, using default host');
        }
        
        if (process.env.DB_PORT_SECRET_NAME) {
          const dbPort = await getSecret(process.env.DB_PORT_SECRET_NAME);
          if (dbPort) {
            config.production.port = parseInt(dbPort, 10);
            console.log(`Updated port to ${config.production.port} from secret ${process.env.DB_PORT_SECRET_NAME}`);
          } else {
            console.warn(`Failed to get port from secret ${process.env.DB_PORT_SECRET_NAME}, using default: ${config.production.port}`);
          }
        } else {
          console.warn('DB_PORT_SECRET_NAME not set, using default port');
        }
        
        console.log('Database configuration updated with AWS Secrets Manager values:', {
          username: '****', // Mask sensitive data
          database: config.production.database,
          host: config.production.host,
          port: config.production.port,
          dialect: config.production.dialect,
          dialectOptions: config.production.dialectOptions
        });
      } catch (error) {
        console.error('Error loading database credentials from AWS Secrets Manager:', error);
        console.warn('Continuing with default configuration due to error');
      }
    };
    
    // Execute the function immediately
    loadDatabaseCredentials();
  }
}

module.exports = config;
