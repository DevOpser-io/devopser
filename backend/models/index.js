/**
 * Database Models
 * Sets up Sequelize and defines models
 */
const { Sequelize, DataTypes } = require('sequelize');
const config = require('../config');
const { getSecret } = require('../services/secretsManager');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const UserModel = require('./User');
const SiteModel = require('./Site');
const DeploymentModel = require('./Deployment');
const SiteImageModel = require('./SiteImage');
const LeadModel = require('./Lead');
const ApiKeyModel = require('./ApiKey');

// Create a module object to export
const db = {};

/**
 * Define the Conversation model
 * @param {Sequelize} sequelizeInstance - Sequelize instance
 * @returns {Model} Conversation model
 */
function defineConversationModel(sequelizeInstance) {
  return sequelizeInstance.define('Conversation', {
    conversation_id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
      unique: true
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Users', // Explicitly reference the Users table with capital U
        key: 'id'
      }
    },
    chat_history: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: []
    },
    started_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    ended_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    is_temporary: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }
  }, {
    tableName: 'conversations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
    indexes: [
      {
        fields: ['user_id']
      },
      {
        fields: ['started_at']
      }
    ]
  });
}

// Log the current environment during database initialization
console.log('==================================================');
console.log(`DATABASE MODELS: Current NODE_ENV is set to: ${process.env.NODE_ENV || 'undefined (defaulting to development)'}`);
console.log('==================================================');

// Create Sequelize instance with development configuration
if (process.env.NODE_ENV !== 'production') {
  console.log('Using local database configuration for development/test');
  db.sequelize = new Sequelize(
    config.database.name,
    config.database.username,
    config.database.password,
    {
      host: config.database.host,
      port: config.database.port,
      dialect: 'postgres',
      logging: config.database.logging ? console.log : false,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
      }
    }
  );
  
  // Initialize models synchronously for development
  db.User = UserModel(db.sequelize);
  db.Conversation = defineConversationModel(db.sequelize);
  db.Site = SiteModel(db.sequelize);
  db.Deployment = DeploymentModel(db.sequelize);
  db.SiteImage = SiteImageModel(db.sequelize);
  db.Lead = LeadModel(db.sequelize);
  db.ApiKey = ApiKeyModel(db.sequelize);

  // Setup associations
  db.User.hasMany(db.Conversation, { foreignKey: 'user_id' });
  db.Conversation.belongsTo(db.User, { foreignKey: 'user_id' });

  // Site associations
  db.User.hasMany(db.Site, { foreignKey: 'user_id', as: 'sites' });
  db.Site.belongsTo(db.User, { foreignKey: 'user_id', as: 'owner' });
  db.Site.hasMany(db.Deployment, { foreignKey: 'site_id', as: 'deployments' });
  db.Deployment.belongsTo(db.Site, { foreignKey: 'site_id', as: 'site' });
  db.Site.hasMany(db.SiteImage, { foreignKey: 'site_id', as: 'images' });
  db.SiteImage.belongsTo(db.Site, { foreignKey: 'site_id', as: 'site' });

  // Lead associations
  db.Site.hasMany(db.Lead, { foreignKey: 'site_id', as: 'leads' });
  db.Lead.belongsTo(db.Site, { foreignKey: 'site_id', as: 'site' });

  // ApiKey associations
  db.User.hasMany(db.ApiKey, { foreignKey: 'user_id', as: 'apiKeys' });
  db.ApiKey.belongsTo(db.User, { foreignKey: 'user_id', as: 'user' });
  db.Site.hasMany(db.ApiKey, { foreignKey: 'site_id', as: 'apiKeys' });
  db.ApiKey.belongsTo(db.Site, { foreignKey: 'site_id', as: 'site' });
}

// Flag to track initialization
let initialized = false;

/**
 * Initialize Sequelize with the appropriate configuration
 * @returns {Promise<Sequelize>} Sequelize instance
 */
async function initializeSequelize() {
  // Log environment again at initialization time
  console.log('==================================================');
  console.log(`SEQUELIZE INIT: Current NODE_ENV is set to: ${process.env.NODE_ENV || 'undefined (defaulting to development)'}`);
  console.log('==================================================');
  
  // Check if we're in production
  if (process.env.NODE_ENV === 'production') {
    try {
      console.log('Initializing database connection in production mode');
      
      // First check if environment variables are directly set (highest priority)
      // This allows the Kubernetes job to set these directly from AWS Secrets Manager
      if (process.env.DB_NAME && process.env.DB_USER && process.env.DB_PASSWORD && 
          process.env.DB_HOST && process.env.DB_PORT) {
        console.log('Using database credentials from environment variables');
        
        return new Sequelize(
          process.env.DB_NAME,
          process.env.DB_USER,
          process.env.DB_PASSWORD,
          {
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT),
            dialect: 'postgres',
            logging: false,
            pool: {
              max: 5,
              min: 0,
              acquire: 30000,
              idle: 10000
            },
            dialectOptions: {
              ssl: {
                require: true,
                rejectUnauthorized: false // Needed for self-signed certificates
              }
            }
          }
        );
      }
      
      // If environment variables aren't set, try to get secrets from AWS Secrets Manager
      console.log('Retrieving database credentials from AWS Secrets Manager');
      
      // Select the local dev DB by authoritative NODE_ENV, not the orchestrator var.
      if (process.env.NODE_ENV !== 'production') {
        console.log('DATABASE INIT: Detected local environment, forcing development mode');
        // Use development configuration instead of trying to access AWS Secrets Manager
        return new Sequelize(
          config.database.development.database,
          config.database.development.username,
          config.database.development.password,
          {
            host: config.database.development.host,
            port: config.database.development.port,
            dialect: config.database.development.dialect,
            logging: config.database.development.logging,
            pool: {
              max: 5,
              min: 0,
              acquire: 30000,
              idle: 10000
            }
          }
        );
      }
      
      // Check if all required secret names are provided
      const { secretNames } = config.database;
      if (!secretNames || !secretNames.dbName || !secretNames.dbUser || !secretNames.dbPassword || 
          !secretNames.dbHost || !secretNames.dbPort) {
        console.warn('Missing required database secret names in environment variables, falling back to development mode');
        // Fall back to development configuration
        return new Sequelize(
          config.database.development.database,
          config.database.development.username,
          config.database.development.password,
          {
            host: config.database.development.host,
            port: config.database.development.port,
            dialect: config.database.development.dialect,
            logging: config.database.development.logging,
            pool: {
              max: 5,
              min: 0,
              acquire: 30000,
              idle: 10000
            }
          }
        );
      }
      
      // Retrieve secrets from AWS Secrets Manager
      const dbName = await getSecret(secretNames.dbName, config.aws.region);
      const dbUser = await getSecret(secretNames.dbUser, config.aws.region);
      const dbPassword = await getSecret(secretNames.dbPassword, config.aws.region);
      const dbHost = await getSecret(secretNames.dbHost, config.aws.region);
      const dbPort = await getSecret(secretNames.dbPort, config.aws.region);
      
      // Validate that we got all the required secrets
      if (!dbName || !dbUser || !dbPassword || !dbHost || !dbPort) {
        throw new Error('Failed to retrieve one or more required database secrets');
      }
      
      console.log(`Successfully retrieved database credentials for ${dbName} at ${dbHost}:${dbPort}`);
      
      // Create Sequelize instance with production configuration from AWS Secrets Manager
      return new Sequelize(
        dbName,
        dbUser,
        dbPassword,
        {
          host: dbHost,
          port: parseInt(dbPort),
          dialect: 'postgres',
          logging: false,
          pool: {
            max: 5,
            min: 0,
            acquire: 30000,
            idle: 10000
          },
          dialectOptions: {
            ssl: {
              require: true,
              rejectUnauthorized: false // Needed for self-signed certificates
            }
          }
        }
      );
    } catch (error) {
      console.error('Failed to initialize database connection in production:', error);
      throw error;
    }
  } else {
    // Development/test environment - use local configuration
    console.log('Using local database configuration for development/test');
    return new Sequelize(
      config.database.name,
      config.database.username,
      config.database.password,
      {
        host: config.database.host,
        port: config.database.port,
        dialect: 'postgres',
        logging: config.database.logging ? console.log : false,
        pool: {
          max: 5,
          min: 0,
          acquire: 30000,
          idle: 10000
        }
      }
    );
  }
}

/**
 * Setup associations between models
 * @param {Model} userModel - User model
 * @param {Model} conversationModel - Conversation model
 */
function setupAssociations(userModel, conversationModel) {
  userModel.hasMany(conversationModel, { foreignKey: 'user_id' });
  conversationModel.belongsTo(userModel, { foreignKey: 'user_id' });
}

/**
 * Setup associations between models
 * @param {Model} userModel - User model
 * @param {Model} conversationModel - Conversation model
 */
function setupAssociations(userModel, conversationModel) {
  userModel.hasMany(conversationModel, { foreignKey: 'user_id' });
  conversationModel.belongsTo(userModel, { foreignKey: 'user_id' });
}

/**
 * Initialize database connection and models
 * @returns {Promise<boolean>} Success status
 */
async function initializeDatabase() {
  try {
    if (initialized) {
      console.log('Database already initialized, skipping initialization');
      return true;
    }
    
    // Log environment again during database initialization
    console.log('==================================================');
    console.log(`DATABASE INIT: Current NODE_ENV is set to: ${process.env.NODE_ENV || 'undefined (defaulting to development)'}`);
    console.log('==================================================');
    
    // Only initialize in production mode, development is already initialized synchronously
    if (process.env.NODE_ENV === 'production') {
      // Initialize Sequelize with the appropriate configuration
      const sequelize = await initializeSequelize();
      db.sequelize = sequelize;

      // Define models with the initialized sequelize instance
      db.User = UserModel(sequelize);
      db.Conversation = defineConversationModel(sequelize);
      db.Site = SiteModel(sequelize);
      db.Deployment = DeploymentModel(sequelize);
      db.SiteImage = SiteImageModel(sequelize);
      db.Lead = LeadModel(sequelize);
      db.ApiKey = ApiKeyModel(sequelize);

      // Setup associations between models
      db.User.hasMany(db.Conversation, { foreignKey: 'user_id' });
      db.Conversation.belongsTo(db.User, { foreignKey: 'user_id' });

      // Site associations
      db.User.hasMany(db.Site, { foreignKey: 'user_id', as: 'sites' });
      db.Site.belongsTo(db.User, { foreignKey: 'user_id', as: 'owner' });
      db.Site.hasMany(db.Deployment, { foreignKey: 'site_id', as: 'deployments' });
      db.Deployment.belongsTo(db.Site, { foreignKey: 'site_id', as: 'site' });
      db.Site.hasMany(db.SiteImage, { foreignKey: 'site_id', as: 'images' });
      db.SiteImage.belongsTo(db.Site, { foreignKey: 'site_id', as: 'site' });

      // Lead associations
      db.Site.hasMany(db.Lead, { foreignKey: 'site_id', as: 'leads' });
      db.Lead.belongsTo(db.Site, { foreignKey: 'site_id', as: 'site' });

      // ApiKey associations
      db.User.hasMany(db.ApiKey, { foreignKey: 'user_id', as: 'apiKeys' });
      db.ApiKey.belongsTo(db.User, { foreignKey: 'user_id', as: 'user' });
      db.Site.hasMany(db.ApiKey, { foreignKey: 'site_id', as: 'apiKeys' });
      db.ApiKey.belongsTo(db.Site, { foreignKey: 'site_id', as: 'site' });
    }
    
    // Test connection
    await db.sequelize.authenticate();
    console.log('Database connection has been established successfully.');
    
    // Sync models with database (don't force in production)
    const syncOptions = { alter: config.env !== 'production' };
    await db.sequelize.sync(syncOptions);
    console.log('Database models synchronized successfully.');
    
    initialized = true;
    return true;
  } catch (error) {
    console.error('Unable to connect to the database:', error);
    return false;
  }
}

// Add the initialization function to the db object
db.initializeDatabase = initializeDatabase;

// Export the db object
module.exports = db;
