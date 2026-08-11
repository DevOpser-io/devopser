/**
 * FILE: backend/services/websiteAgentTools.js
 * PURPOSE: Tool definitions for the website builder AI agent
 * DESCRIPTION: Defines tools that Claude can use to modify website configurations.
 *              Uses Claude's native tool use feature via Bedrock.
 */

const { SECTION_SCHEMAS, THEME_PRESETS, AVAILABLE_ICONS } = require('../config/sectionSchemas');
const { v4: uuidv4 } = require('uuid');
const { PAGE_TEMPLATES, addPageToConfig, removePageFromConfig, getAvailableTemplates } = require('./pageTemplates');

/**
 * Tool definitions for Claude
 * These follow the Anthropic tool use schema
 */
const WEBSITE_TOOLS = [
  {
    name: 'update_theme',
    description: 'Update the website theme colors and font. Use this when the user wants to change colors, fonts, or apply a theme preset.',
    input_schema: {
      type: 'object',
      properties: {
        primaryColor: {
          type: 'string',
          description: 'Primary brand color in hex format (e.g., "#3B82F6")'
        },
        secondaryColor: {
          type: 'string',
          description: 'Secondary accent color in hex format (e.g., "#10B981")'
        },
        backgroundColor: {
          type: 'string',
          description: 'Background color in hex format (e.g., "#FFFFFF")'
        },
        textColor: {
          type: 'string',
          description: 'Main text color in hex format (e.g., "#1F2937")'
        },
        fontFamily: {
          type: 'string',
          description: 'Font family name (e.g., "Inter", "Roboto", "Poppins")'
        },
        preset: {
          type: 'string',
          enum: Object.keys(THEME_PRESETS),
          description: 'Apply a preset theme: ' + Object.entries(THEME_PRESETS).map(([k, v]) => `${k} (${v.name})`).join(', ')
        }
      }
    }
  },
  {
    name: 'add_section',
    description: 'Add a new section to the current page. Available section types: hero (main banner), features (feature grid), about (about text), testimonials (customer quotes), pricing (pricing tiers), contact (contact info), footer (site footer), team (team member cards), services (service offerings), story (about story with image), gallery (image gallery), contactForm (lead capture form).',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: Object.keys(SECTION_SCHEMAS),
          description: 'Type of section to add'
        },
        position: {
          type: 'integer',
          description: 'Position to insert the section (0 = first, omit for end)'
        },
        content: {
          type: 'object',
          description: 'Section content. Structure depends on section type.'
        },
        pageId: {
          type: 'string',
          description: 'ID of the page to add section to. If omitted, uses the current/first page.'
        }
      },
      required: ['type']
    }
  },
  {
    name: 'update_section',
    description: 'Update an existing section\'s content. Use this to change headlines, text, features, pricing, etc.',
    input_schema: {
      type: 'object',
      properties: {
        sectionId: {
          type: 'string',
          description: 'ID of the section to update (e.g., "hero-1", "features-1")'
        },
        sectionType: {
          type: 'string',
          enum: Object.keys(SECTION_SCHEMAS),
          description: 'Type of section (helps identify if sectionId is ambiguous)'
        },
        content: {
          type: 'object',
          description: 'Partial content update - only include fields to change'
        },
        visible: {
          type: 'boolean',
          description: 'Set to false to hide the section, true to show'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'remove_section',
    description: 'Remove a section from the website.',
    input_schema: {
      type: 'object',
      properties: {
        sectionId: {
          type: 'string',
          description: 'ID of the section to remove'
        },
        sectionType: {
          type: 'string',
          enum: Object.keys(SECTION_SCHEMAS),
          description: 'Type of section to remove (if sectionId not known)'
        }
      }
    }
  },
  {
    name: 'reorder_sections',
    description: 'Change the order of sections on the page.',
    input_schema: {
      type: 'object',
      properties: {
        newOrder: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of section IDs in the desired order'
        },
        moveSection: {
          type: 'object',
          properties: {
            sectionId: { type: 'string' },
            direction: { type: 'string', enum: ['up', 'down', 'first', 'last'] }
          },
          description: 'Alternative: move a single section up/down/first/last'
        }
      }
    }
  },
  {
    name: 'create_full_site',
    description: 'Create a complete website from scratch with multiple sections. Use this for initial site creation when the user describes a new website.',
    input_schema: {
      type: 'object',
      properties: {
        siteName: {
          type: 'string',
          description: 'Name of the website'
        },
        theme: {
          type: 'object',
          properties: {
            primaryColor: { type: 'string' },
            secondaryColor: { type: 'string' },
            backgroundColor: { type: 'string' },
            textColor: { type: 'string' },
            fontFamily: { type: 'string' }
          },
          description: 'Theme configuration'
        },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: Object.keys(SECTION_SCHEMAS) },
              content: { type: 'object' }
            },
            required: ['type']
          },
          description: 'Array of sections to create'
        }
      },
      required: ['siteName', 'sections']
    }
  },
  {
    name: 'add_page',
    description: 'Add a new page to the website using a template. Available templates: home (landing page with hero, features, testimonials), about (company story and team), services (service offerings and pricing), contact (contact form with business info), team (team members), gallery (image showcase).',
    input_schema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          enum: Object.keys(PAGE_TEMPLATES),
          description: 'Page template to use'
        },
        name: {
          type: 'string',
          description: 'Custom page name (optional, uses template name if not provided)'
        },
        slug: {
          type: 'string',
          description: 'URL slug for the page (optional, uses template slug if not provided)'
        }
      },
      required: ['template']
    }
  },
  {
    name: 'remove_page',
    description: 'Remove a page from the website. Cannot remove the home page.',
    input_schema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'ID of the page to remove'
        },
        pageName: {
          type: 'string',
          description: 'Name of the page to remove (alternative to pageId)'
        }
      }
    }
  },
  {
    name: 'list_pages',
    description: 'List all pages in the website with their IDs, names, and slugs.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'update_navigation',
    description: 'Update the site navigation menu order or labels.',
    input_schema: {
      type: 'object',
      properties: {
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pageId: { type: 'string', description: 'ID of the page' },
              label: { type: 'string', description: 'Display label in navigation' }
            },
            required: ['pageId', 'label']
          },
          description: 'Array of navigation links in desired order'
        },
        style: {
          type: 'string',
          enum: ['fixed-top', 'static', 'hidden'],
          description: 'Navigation bar style'
        }
      }
    }
  }
];

/**
 * Execute a tool call and return the result
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} toolInput - Input parameters for the tool
 * @param {Object} currentConfig - Current site configuration
 * @returns {Object} - { success, config, message }
 */
function executeTool(toolName, toolInput, currentConfig) {
  // Clone config to avoid mutation
  let config = currentConfig ? JSON.parse(JSON.stringify(currentConfig)) : {
    siteName: 'My Website',
    theme: { ...THEME_PRESETS.blue },
    sections: []
  };

  try {
    switch (toolName) {
      case 'update_theme':
        return executeUpdateTheme(config, toolInput);

      case 'add_section':
        return executeAddSection(config, toolInput);

      case 'update_section':
        return executeUpdateSection(config, toolInput);

      case 'remove_section':
        return executeRemoveSection(config, toolInput);

      case 'reorder_sections':
        return executeReorderSections(config, toolInput);

      case 'create_full_site':
        return executeCreateFullSite(config, toolInput);

      case 'add_page':
        return executeAddPage(config, toolInput);

      case 'remove_page':
        return executeRemovePage(config, toolInput);

      case 'list_pages':
        return executeListPages(config, toolInput);

      case 'update_navigation':
        return executeUpdateNavigation(config, toolInput);

      default:
        return {
          success: false,
          config,
          message: `Unknown tool: ${toolName}`
        };
    }
  } catch (error) {
    console.error(`[Tools] Error executing ${toolName}:`, error);
    return {
      success: false,
      config,
      message: `Error: ${error.message}`
    };
  }
}

/**
 * Update theme colors/fonts
 */
function executeUpdateTheme(config, input) {
  // Apply preset if specified
  if (input.preset && THEME_PRESETS[input.preset]) {
    config.theme = { ...config.theme, ...THEME_PRESETS[input.preset] };
  }

  // Apply individual overrides
  if (input.primaryColor) config.theme.primaryColor = input.primaryColor;
  if (input.secondaryColor) config.theme.secondaryColor = input.secondaryColor;
  if (input.backgroundColor) config.theme.backgroundColor = input.backgroundColor;
  if (input.textColor) config.theme.textColor = input.textColor;
  if (input.fontFamily) config.theme.fontFamily = input.fontFamily;

  return {
    success: true,
    config,
    message: 'Theme updated successfully'
  };
}

/**
 * Add a new section
 */
function executeAddSection(config, input) {
  const schema = SECTION_SCHEMAS[input.type];
  if (!schema) {
    return {
      success: false,
      config,
      message: `Unknown section type: ${input.type}`
    };
  }

  const newSection = {
    id: `${input.type}-${uuidv4().slice(0, 8)}`,
    type: input.type,
    order: 0,
    visible: true,
    content: {
      ...schema.defaultContent,
      ...(input.content || {})
    }
  };

  // Determine position
  const position = input.position !== undefined ? input.position : config.sections.length;

  // Insert at position
  config.sections.splice(position, 0, newSection);

  // Update order of all sections
  config.sections.forEach((s, idx) => s.order = idx);

  return {
    success: true,
    config,
    message: `Added ${schema.displayName} section`
  };
}

/**
 * Update an existing section
 */
function executeUpdateSection(config, input) {
  // Find section by ID or type
  let sectionIndex = -1;

  if (input.sectionId) {
    sectionIndex = config.sections.findIndex(s => s.id === input.sectionId);
  }

  if (sectionIndex === -1 && input.sectionType) {
    sectionIndex = config.sections.findIndex(s => s.type === input.sectionType);
  }

  if (sectionIndex === -1) {
    // Try to find by type from the content hints
    const possibleTypes = Object.keys(SECTION_SCHEMAS);
    for (const type of possibleTypes) {
      const idx = config.sections.findIndex(s => s.type === type);
      if (idx !== -1) {
        // Check if content keys match this section type
        const contentKeys = Object.keys(input.content || {});
        const schemaKeys = Object.keys(SECTION_SCHEMAS[type].schema || {});
        if (contentKeys.some(k => schemaKeys.includes(k))) {
          sectionIndex = idx;
          break;
        }
      }
    }
  }

  if (sectionIndex === -1) {
    return {
      success: false,
      config,
      message: 'Section not found. Available sections: ' + config.sections.map(s => `${s.id} (${s.type})`).join(', ')
    };
  }

  const section = config.sections[sectionIndex];

  // Store previous values for rollback support
  const previousContent = JSON.parse(JSON.stringify(section.content));
  const changedFields = [];

  // Update content (deep merge)
  if (input.content) {
    // Track what fields are being changed
    for (const [key, newValue] of Object.entries(input.content)) {
      const oldValue = section.content[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changedFields.push({
          field: key,
          oldValue: oldValue,
          newValue: newValue
        });
      }
    }
    section.content = deepMerge(section.content, input.content);
  }

  // Update visibility
  if (input.visible !== undefined) {
    section.visible = input.visible;
  }

  // Build detailed message with change info for rollback support
  let message = `Updated ${section.type} section.`;
  if (changedFields.length > 0) {
    const changeDetails = changedFields.map(c => {
      const oldDisplay = c.oldValue !== undefined ? JSON.stringify(c.oldValue) : 'not set';
      return `${c.field}: ${oldDisplay} → ${JSON.stringify(c.newValue)}`;
    }).join(', ');
    message += ` Changes: ${changeDetails}`;
  }

  return {
    success: true,
    config,
    message,
    previousContent // Include for potential rollback
  };
}

/**
 * Remove a section
 */
function executeRemoveSection(config, input) {
  let sectionIndex = -1;

  if (input.sectionId) {
    sectionIndex = config.sections.findIndex(s => s.id === input.sectionId);
  }

  if (sectionIndex === -1 && input.sectionType) {
    sectionIndex = config.sections.findIndex(s => s.type === input.sectionType);
  }

  if (sectionIndex === -1) {
    return {
      success: false,
      config,
      message: 'Section not found'
    };
  }

  const removed = config.sections.splice(sectionIndex, 1)[0];

  // Update order of remaining sections
  config.sections.forEach((s, idx) => s.order = idx);

  return {
    success: true,
    config,
    message: `Removed ${removed.type} section`
  };
}

/**
 * Reorder sections
 */
function executeReorderSections(config, input) {
  if (input.newOrder && Array.isArray(input.newOrder)) {
    // Full reorder
    const sectionMap = new Map(config.sections.map(s => [s.id, s]));
    const newSections = [];

    for (const id of input.newOrder) {
      if (sectionMap.has(id)) {
        newSections.push(sectionMap.get(id));
        sectionMap.delete(id);
      }
    }

    // Add any sections not in the new order at the end
    for (const section of sectionMap.values()) {
      newSections.push(section);
    }

    config.sections = newSections;
    config.sections.forEach((s, idx) => s.order = idx);
  } else if (input.moveSection) {
    // Move single section
    const { sectionId, direction } = input.moveSection;
    const idx = config.sections.findIndex(s => s.id === sectionId);

    if (idx !== -1) {
      const section = config.sections.splice(idx, 1)[0];
      let newIdx;

      switch (direction) {
        case 'up':
          newIdx = Math.max(0, idx - 1);
          break;
        case 'down':
          newIdx = Math.min(config.sections.length, idx + 1);
          break;
        case 'first':
          newIdx = 0;
          break;
        case 'last':
          newIdx = config.sections.length;
          break;
        default:
          newIdx = idx;
      }

      config.sections.splice(newIdx, 0, section);
      config.sections.forEach((s, i) => s.order = i);
    }
  }

  return {
    success: true,
    config,
    message: 'Sections reordered'
  };
}

/**
 * Create a complete site from scratch
 */
function executeCreateFullSite(existingConfig, input) {
  // If there's already a site with sections, warn and merge instead of replace
  if (existingConfig && existingConfig.sections && existingConfig.sections.length > 0) {
    console.log('[Tools] create_full_site called on existing site - merging instead of replacing');

    // Update siteName and theme if provided
    const config = JSON.parse(JSON.stringify(existingConfig));
    if (input.siteName) config.siteName = input.siteName;
    if (input.theme) {
      config.theme = { ...config.theme, ...input.theme };
    }

    // For sections, only add new ones that don't exist
    if (input.sections && input.sections.length > 0) {
      const existingTypes = config.sections.map(s => s.type);

      input.sections.forEach((sectionInput) => {
        // If this section type already exists, update it instead
        const existingIdx = config.sections.findIndex(s => s.type === sectionInput.type);
        if (existingIdx !== -1) {
          // Merge content, preserving existing values
          config.sections[existingIdx].content = {
            ...config.sections[existingIdx].content,
            ...(sectionInput.content || {})
          };
        } else {
          // Add new section at the end
          const schema = SECTION_SCHEMAS[sectionInput.type];
          if (schema) {
            config.sections.push({
              id: `${sectionInput.type}-${uuidv4().slice(0, 8)}`,
              type: sectionInput.type,
              order: config.sections.length,
              visible: true,
              content: {
                ...schema.defaultContent,
                ...(sectionInput.content || {})
              }
            });
          }
        }
      });
    }

    return {
      success: true,
      config,
      message: `Updated existing website "${config.siteName}" - preserved ${existingConfig.sections.length} sections`
    };
  }

  // No existing config - create fresh
  const config = {
    siteName: input.siteName || 'My Website',
    theme: {
      ...THEME_PRESETS.blue,
      ...(input.theme || {})
    },
    sections: []
  };

  // Add each section
  (input.sections || []).forEach((sectionInput, idx) => {
    const schema = SECTION_SCHEMAS[sectionInput.type];
    if (schema) {
      config.sections.push({
        id: `${sectionInput.type}-${uuidv4().slice(0, 8)}`,
        type: sectionInput.type,
        order: idx,
        visible: true,
        content: {
          ...schema.defaultContent,
          ...(sectionInput.content || {})
        }
      });
    }
  });

  return {
    success: true,
    config,
    message: `Created website "${config.siteName}" with ${config.sections.length} sections`
  };
}

/**
 * Add a new page to the site
 */
function executeAddPage(config, input) {
  try {
    const overrides = {};
    if (input.name) overrides.name = input.name;
    if (input.slug) overrides.slug = input.slug;

    const newConfig = addPageToConfig(config, input.template, overrides);
    const newPage = newConfig.pages[newConfig.pages.length - 1];

    return {
      success: true,
      config: newConfig,
      message: `Added "${newPage.name}" page (${newPage.slug ? '/' + newPage.slug : 'home'}) with ${newPage.sections.length} sections`
    };
  } catch (error) {
    return {
      success: false,
      config,
      message: `Error adding page: ${error.message}`
    };
  }
}

/**
 * Remove a page from the site
 */
function executeRemovePage(config, input) {
  // Find page by ID or name
  let pageId = input.pageId;

  if (!pageId && input.pageName && config.pages) {
    const page = config.pages.find(p =>
      p.name.toLowerCase() === input.pageName.toLowerCase()
    );
    if (page) pageId = page.id;
  }

  if (!pageId) {
    return {
      success: false,
      config,
      message: 'Page not found. Available pages: ' + (config.pages ? config.pages.map(p => `${p.name} (${p.id})`).join(', ') : 'none')
    };
  }

  try {
    const newConfig = removePageFromConfig(config, pageId);
    return {
      success: true,
      config: newConfig,
      message: `Removed page successfully`
    };
  } catch (error) {
    return {
      success: false,
      config,
      message: `Error removing page: ${error.message}`
    };
  }
}

/**
 * List all pages in the site
 */
function executeListPages(config, input) {
  if (!config.pages || config.pages.length === 0) {
    return {
      success: true,
      config,
      message: 'No pages in site. Site uses legacy single-page format with sections at root.'
    };
  }

  const pageList = config.pages.map(p => {
    const slug = p.slug || '(home)';
    return `- ${p.name} (ID: ${p.id}, URL: /${slug}, ${p.sections.length} sections)`;
  }).join('\n');

  return {
    success: true,
    config,
    message: `Site has ${config.pages.length} page(s):\n${pageList}`
  };
}

/**
 * Update navigation configuration
 */
function executeUpdateNavigation(config, input) {
  const newConfig = JSON.parse(JSON.stringify(config));

  if (!newConfig.navigation) {
    newConfig.navigation = {
      style: 'fixed-top',
      logo: { url: null, alt: newConfig.siteName },
      links: []
    };
  }

  if (input.links) {
    newConfig.navigation.links = input.links;
  }

  if (input.style) {
    newConfig.navigation.style = input.style;
  }

  return {
    success: true,
    config: newConfig,
    message: 'Navigation updated successfully'
  };
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Generate property documentation for a section schema
 */
function generateSchemaDocumentation(type, schema) {
  const props = [];
  for (const [key, spec] of Object.entries(schema.schema || {})) {
    let desc = key;
    if (spec.type === 'array' && spec.itemSchema) {
      const itemProps = Object.keys(spec.itemSchema).join(', ');
      desc = `${key}: array of objects with {${itemProps}}`;
      if (spec.maxItems) desc += ` (max ${spec.maxItems} items)`;
    } else if (spec.type === 'enum') {
      desc = `${key}: one of [${spec.values.join(', ')}]`;
    } else {
      desc = `${key}: ${spec.type}${spec.required ? ' (required)' : ''}`;
      if (spec.maxLength) desc += ` (max ${spec.maxLength} chars)`;
    }
    props.push(`  - ${desc}`);
  }
  return props.join('\n');
}

/**
 * Get the system prompt for the agent
 */
function getAgentSystemPrompt(currentConfig) {
  // Generate complete property documentation for all section types
  const sectionDocs = Object.entries(SECTION_SCHEMAS).map(([type, schema]) => {
    return `### ${type.toUpperCase()} SECTION
${schema.description}
Valid properties:
${generateSchemaDocumentation(type, schema)}`;
  }).join('\n\n');

  // Generate page templates documentation
  const templateDocs = Object.entries(PAGE_TEMPLATES).map(([id, template]) => {
    return `- ${id}: ${template.description}`;
  }).join('\n');

  let prompt = `You are a website builder AI assistant for DevOpser Lite.
You help users create and modify MULTI-PAGE websites by using the available tools.

## CRITICAL CONSTRAINTS - READ FIRST
1. You can ONLY use properties listed in this prompt - DO NOT invent new properties
2. All values must match the types specified (string, hex color, array, etc.)
3. DO NOT use CSS class names, Tailwind classes, or any styling syntax
4. DO NOT suggest external fonts, CDNs, or external resources
5. Colors MUST be hex format like "#000000", never CSS names like "black"
6. You MUST call tools to make changes - never just describe what you would do

## MULTI-PAGE ARCHITECTURE
DevOpser Lite supports multi-page websites:
- Websites can have multiple pages (Home, About, Services, Contact, etc.)
- Each page has its own sections
- Pages are linked through navigation menu
- Use add_page to add new pages from templates
- Use list_pages to see all pages
- Use remove_page to delete a page (except home)
- Use update_navigation to manage the menu

## PAGE TEMPLATES
Available page templates for add_page:
${templateDocs}

Example: add_page with template: "about" to add an About Us page

## SECTION TYPES
Available section types for any page:
- hero: Main banner with headline, background, and CTA button
- features: Feature grid with icons and descriptions
- about: About text section
- testimonials: Customer quotes and reviews
- pricing: Pricing tiers and plans
- contact: Contact information display
- footer: Site footer with links
- team: Team member cards with photos, names, roles
- services: Service offerings with icons, descriptions, prices
- story: Company story section with image and highlights
- gallery: Image gallery grid with lightbox
- contactForm: Lead capture form with customizable fields

## SYSTEM ARCHITECTURE & STRICT CSP COMPLIANCE
DevOpser Lite is a JSON-based website builder with STRICT Content Security Policy:
- Websites are JSON configurations with pages containing sections
- The JSON maps to pre-built, CSP-compliant HTML/CSS templates
- Users edit content via drag-and-drop editor OR chat with you
- Sites deploy to Kubernetes with strict Content Security Policy (CSP)

### CSP RULES (CRITICAL - ENFORCED BY BROWSER):
1. NO inline styles (style="...") - will be BLOCKED
2. NO inline scripts - will be BLOCKED
3. NO external fonts or CDNs - will be BLOCKED
4. NO event handlers in HTML (onclick="...") - will be BLOCKED
5. ALL styling is through CSS classes in external stylesheets
6. ALL JavaScript in external files only
7. Colors are applied via CSS custom properties (--primary-color, etc.)
8. Background colors use data-* attributes + CSS classes, NOT inline styles

## WHAT YOU CAN DO
- Add new pages with add_page using templates (about, services, contact, team, gallery)
- List pages with list_pages
- Remove pages with remove_page
- Update navigation menu with update_navigation
- Create new websites with create_full_site (ONLY for brand new empty sites)
- Add/remove/reorder sections with add_section, remove_section, reorder_sections
- Update section content (text, colors, items) with update_section
- Change theme colors and fonts with update_theme

## WHAT YOU CANNOT DO
- Add custom CSS, inline styles, or styling attributes
- Add custom HTML or JavaScript
- Use properties not listed below
- Suggest features the system doesn't support
- NEVER suggest style="..." attributes - they violate CSP and will be blocked

## IMAGES AND PLACEHOLDERS
When creating sections that support images (team, story, gallery, about, testimonials):
- ALWAYS include placeholder images using placehold.co format
- Placeholder format: https://placehold.co/WIDTHxHEIGHT/BG_COLOR/TEXT_COLOR?text=LABEL
- The BG_COLOR should match the theme's primary or secondary color (without #)
- Examples:
  - Team member photo: https://placehold.co/200x200/3B82F6/white?text=JS (use initials)
  - Story/About image: https://placehold.co/600x400/f3f4f6/6b7280?text=Our+Story
  - Gallery image: https://placehold.co/400x400/3B82F6/white?text=Project+1
  - Testimonial avatar: https://placehold.co/100x100/10B981/white?text=JD
- ALWAYS populate image fields with placeholders when creating new sections
- Users can later replace placeholders with real images via the visual editor
- If user provides an image URL, use that instead of a placeholder

## MOBILE-FIRST & RESPONSIVE DESIGN
All websites built with DevOpser Lite are automatically responsive:
- The system uses CSS that adapts to all screen sizes (mobile, tablet, desktop)
- Keep text concise for mobile readability:
  - Headlines: max 6-8 words
  - Subheadlines: max 15-20 words
  - Feature descriptions: max 2-3 sentences
- Use clear, scannable content:
  - Short paragraphs
  - Bullet points for lists
  - Clear CTAs (call-to-action buttons)
- Ensure all content is accessible and readable on small screens
- Avoid long unbroken text blocks - break into digestible chunks

## CRITICAL: PRESERVING USER CHANGES
The user may have made changes via the visual editor (drag-drop, inline editing).
These changes are reflected in the CURRENT SITE CONFIGURATION below.
YOU MUST PRESERVE THESE CHANGES:
- NEVER use create_full_site if pages/sections already exist - use update_section instead
- When updating a section, only change the specific fields requested
- Preserve section ORDER - sections have been reordered by the user
- Preserve existing content that the user didn't ask to change

## CURRENT SITE CONFIGURATION
${currentConfig ? JSON.stringify(currentConfig, null, 2) : 'No site created yet'}

## SECTION TYPES AND VALID PROPERTIES
IMPORTANT: Only use properties listed here. Any other property will be ignored.

${sectionDocs}

## THEME PROPERTIES
The theme object supports:
- primaryColor: hex color (e.g., "#3B82F6")
- secondaryColor: hex color (e.g., "#10B981")
- backgroundColor: hex color (e.g., "#FFFFFF")
- textColor: hex color (e.g., "#1F2937")
- fontFamily: font name (system fonts only: Inter, Roboto, etc.)

Available presets: ${Object.keys(THEME_PRESETS).join(', ')}

## AVAILABLE ICONS
For feature/service icons, use: ${AVAILABLE_ICONS.join(', ')}

## COMMON TASKS - EXACT SYNTAX

### Add a new page:
add_page with template: "about" (or "services", "contact", "team", "gallery")

### Change hero background to black:
update_section with sectionType: "hero", content: {
  "backgroundColorStart": "#000000",
  "backgroundColorEnd": "#1a1a1a"
}

### Change theme colors:
update_theme with primaryColor: "#8B5CF6", secondaryColor: "#EC4899"

### Update headline:
update_section with sectionType: "hero", content: { "headline": "New Headline" }

### Add a team member:
update_section with sectionType: "team", content: {
  "members": [existing members..., { "name": "Jane", "role": "Developer", "bio": "...", "photo": "URL" }]
}

### Add a service:
update_section with sectionType: "services", content: {
  "items": [existing items..., { "icon": "wrench", "title": "New Service", "description": "...", "price": "$99" }]
}

## ROLLBACK SUPPORT
When update_section runs, it returns: "Changes: field: oldValue → newValue"
To undo, call update_section with the old values shown.

## RESPONSE STYLE
- Be concise and friendly.
- Confirm what you changed.
- Don't explain how the system works unless asked.
- If user asks for something impossible, explain what IS possible.

## RESPONSE FORMAT — STRICT
Your response is rendered through a Markdown parser (marked + DOMPurify) on both \`/\` (landing preview) and \`/sites/:id/builder\`. Output MUST be valid Markdown so it renders correctly.

- Use Markdown syntax only: \`##\` / \`###\` headings, \`-\` bullet lists, \`**bold**\`, \`*italic*\`, \`[text](url)\`, fenced code blocks where appropriate.
- **DO NOT use emoji characters anywhere in your response.** No ✅, ✨, 🎨, ⚡, 🚀, 📱, 🔧, 💡, 🎯, etc. No emoji bullets, no emoji decorations, no emoji section markers. Zero Unicode pictographs.
- If you need to list features or changes, use a plain Markdown bullet list:
  \`\`\`
  - Hero section with headline and CTA
  - Features grid with 6 items
  - Contact form for lead capture
  \`\`\`
  NOT: \`✅ Hero Section - headline and CTA ✅ Features - 6 items\`.
- Do not prefix bullets with check marks, arrows, sparkles, or any other symbol — a plain \`-\` is the bullet.
- Keep replies under ~6 short bullets unless the user asked for detail.
`;

  return prompt;
}

module.exports = {
  WEBSITE_TOOLS,
  executeTool,
  getAgentSystemPrompt
};
