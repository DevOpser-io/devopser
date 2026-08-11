/**
 * Create Admin User Script
 * 
 * This script creates an admin user in the database
 * Usage: node create-admin.js <email> <password>
 */

// Use DOTENV_CONFIG_PATH if provided, otherwise default to '../.env'
const dotenvPath = process.env.DOTENV_CONFIG_PATH || '../.env';
require('dotenv').config({ path: dotenvPath });
console.log(`Loading environment from: ${dotenvPath}`);

// Import the entire db object instead of destructuring
const db = require('../models');

async function createAdminUser() {
  try {
    // Get email and password from command line arguments
    const email = process.argv[2];
    const password = process.argv[3];
    
    if (!email || !password) {
      console.error('Usage: node create-admin.js <email> <password>');
      process.exit(1);
    }
    
    // Initialize database connection
    await db.initializeDatabase();
    console.log('Database connection established');
    
    // Check if user already exists - access User through db object
    let user = await db.User.findOne({ where: { email } });
    
    if (user) {
      // Create-only: do NOT re-grant admin or reset the password for an
      // existing user. Overwriting on every boot would reverse a deliberate
      // admin revocation and clobber a rotated password.
      console.log(`User ${email} already exists; leaving isAdmin and password unchanged`);
    } else {
      // Create new admin user
      user = await db.User.create({
        email,
        name: 'Admin User',
        isAdmin: true,
        emailVerified: true,
        isActive: true
      });
      
      await user.setPassword(password);
      await user.save();
      console.log(`Admin user ${email} created successfully`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
}

createAdminUser();
