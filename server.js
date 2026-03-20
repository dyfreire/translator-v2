import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Environment variables
const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uwjgumhqvqglffgqrcsu.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3amd1bWhxdnFnbGZmZ3FyY3N1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI1MDgyMTIsImV4cCI6MjA3ODA4NDIxMn0.gF00kOYQHOGThBRCBZ833pcAM-2diCIRmA-5h2tkLVM';
const ROUTELLM_API_KEY = process.env.ROUTELLM_API_KEY || 's2_e4c0d002d03947bf9045aa95d4f15302';

// Initialize Fastify
const fastify = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true
      }
    }
  }
});

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Register plugins
await fastify.register(cors, {
  origin: true,
  credentials: true
});

await fastify.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

// Serve static files for frontend (if built)
const distPath = path.join(__dirname, 'frontend', 'dist');
try {
  await fs.access(distPath);
  await fastify.register(staticFiles, {
    root: distPath,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback: serve index.html for non-API routes
  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Route not found' });
    }
    return reply.sendFile('index.html');
  });
} catch {
  console.log('⚠️  frontend/dist not found — run "npm run build" to generate it');
  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Route not found' });
    }
    return reply.code(404).send({ error: 'Frontend not built. Run npm run build.' });
  });
}

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
try {
  await fs.mkdir(uploadsDir, { recursive: true });
} catch (error) {
  console.log('Uploads directory exists or created');
}

// Helper: create a Supabase client authenticated with the user's JWT
function createUserClient(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

// Auth middleware
async function authMiddleware(request, reply) {
  const authHeader = request.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');
  
  if (!token) {
    return reply.code(401).send({ error: 'No token provided' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return reply.code(401).send({ error: 'Invalid token' });
    }
    request.user = user;
    request.userToken = token;
    request.supabase = createUserClient(token);
  } catch (error) {
    return reply.code(401).send({ error: 'Auth failed' });
  }
}

// Routes
fastify.get('/api/health', async () => {
  return { 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  };
});

// Auth routes
fastify.post('/api/auth/login', async (request, reply) => {
  const { email, password } = request.body;
  
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      return reply.code(400).send({ error: error.message });
    }

    return {
      user: data.user,
      session: data.session,
      token: data.session.access_token
    };
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
});

fastify.post('/api/auth/signup', async (request, reply) => {
  const { email, password, name } = request.body;
  
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name }
      }
    });

    if (error) {
      return reply.code(400).send({ error: error.message });
    }

    return {
      user: data.user,
      session: data.session,
      message: 'Check your email to verify account'
    };
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
});

// Documents routes  
fastify.post('/api/documents/upload', { 
  preHandler: authMiddleware 
}, async (request, reply) => {
  try {
    const data = await request.file();
    
    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    const allowedTypes = ['.pdf', '.docx'];
    const fileExt = path.extname(data.filename).toLowerCase();
    
    if (!allowedTypes.includes(fileExt)) {
      return reply.code(400).send({ error: 'Only PDF and DOCX files allowed' });
    }

    const documentId = uuidv4();
    const filename = `${documentId}${fileExt}`;
    const filePath = path.join(uploadsDir, filename);

    // Save file
    const buffer = await data.toBuffer();
    await fs.writeFile(filePath, buffer);

    // Get form fields
    const fields = {};
    if (request.body) {
      for (const [key, value] of Object.entries(request.body)) {
        fields[key] = value.value || value;
      }
    }

    // Save to database - NO TEXT PROCESSING ON SERVER
    const { error: dbError } = await request.supabase.from('documents').insert({
      id: documentId,
      user_id: request.user.id,
      filename: data.filename,
      file_path: filename,
      source_language: fields.sourceLanguage || 'auto',
      target_language: fields.targetLanguage || 'pt',
      status: 'uploaded',
      segments: [], // Will be processed on frontend
      metadata: { 
        fileSize: buffer.length,
        uploadedAt: new Date().toISOString()
      },
      created_at: new Date().toISOString()
    });

    if (dbError) {
      throw new Error(`Database error: ${dbError.message}`);
    }

    return {
      documentId,
      filename: data.filename,
      fileSize: buffer.length,
      message: 'File uploaded successfully. Processing will happen on frontend.'
    };

  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

fastify.get('/api/documents', { 
  preHandler: authMiddleware 
}, async (request, reply) => {
  try {
    const { data, error } = await request.supabase
      .from('documents')
      .select('*')
      .eq('user_id', request.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    return { documents: data || [] };
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
});

fastify.get('/api/documents/:id', { 
  preHandler: authMiddleware 
}, async (request, reply) => {
  try {
    const { id } = request.params;

    const { data, error } = await request.supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', request.user.id)
      .single();

    if (error || !data) {
      return reply.code(404).send({ error: 'Document not found' });
    }

    return { document: data };
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
});

fastify.put('/api/documents/:id/segments', { 
  preHandler: authMiddleware 
}, async (request, reply) => {
  try {
    const { id } = request.params;
    const { segments } = request.body;

    const { error } = await request.supabase
      .from('documents')
      .update({
        segments,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('user_id', request.user.id);

    if (error) {
      throw new Error(error.message);
    }

    return { success: true };
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
});

// Serve uploaded files
fastify.get('/api/files/:filename', async (request, reply) => {
  try {
    const { filename } = request.params;
    const filePath = path.join(uploadsDir, filename);
    
    const file = await fs.readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeType = ext === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    
    return reply
      .type(mimeType)
      .header('Cache-Control', 'public, max-age=3600')
      .send(file);
  } catch (error) {
    return reply.code(404).send({ error: 'File not found' });
  }
});

// Document analysis endpoint - identifies document type for better translation context
fastify.post('/api/analyze-document', {
  preHandler: authMiddleware
}, async (request, reply) => {
  try {
    const { text, sourceLanguage } = request.body;

    const response = await fetch('https://routellm.abacus.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ROUTELLM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: `You are a document analyst specialized in legal and immigration documents. Analyze the text and respond ONLY with a JSON object (no markdown, no explanation) in this exact format:
{"documentType": "<type>", "context": "<brief context>", "terminology": "<key terms guidance>"}

Document types: birth_certificate, death_certificate, marriage_certificate, criminal_record, school_document, university_diploma, power_of_attorney, deed, immigration_form, support_letter, medical_record, financial_document, identity_document, other

The "context" should describe what the document is about in one sentence.
The "terminology" should list key domain-specific terms and how they should be translated accurately.`
          },
          {
            role: 'user',
            content: `Analyze this ${sourceLanguage} document:\n\n${text.substring(0, 3000)}`
          }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`Analysis API error: ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();

    // Parse JSON response, handle possible markdown wrapping
    let analysis;
    try {
      const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(jsonStr);
    } catch {
      analysis = { documentType: 'other', context: content, terminology: '' };
    }

    return analysis;
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

// Translation endpoint
fastify.post('/api/translate', { 
  preHandler: authMiddleware 
}, async (request, reply) => {
  try {
    const { text, sourceLanguage, targetLanguage, documentContext } = request.body;

    // Build system prompt with document context if available
    let systemPrompt = `You are a professional legal document translator specializing in immigration documents. Translate the given text from ${sourceLanguage} to ${targetLanguage}. Return ONLY the translated text, nothing else.`;

    if (documentContext) {
      systemPrompt += `\n\nDocument type: ${documentContext.documentType || 'unknown'}.`;
      if (documentContext.context) {
        systemPrompt += ` Context: ${documentContext.context}.`;
      }
      if (documentContext.terminology) {
        systemPrompt += ` Key terminology guidance: ${documentContext.terminology}.`;
      }
      systemPrompt += `\nUse appropriate legal and domain-specific terminology for this document type. Maintain formal register.`;
    }

    const response = await fetch('https://routellm.abacus.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ROUTELLM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`Translation API error: ${response.statusText}`);
    }

    const data = await response.json();
    const translatedText = data.choices[0].message.content;

    return { translatedText };
  } catch (error) {
    return reply.code(500).send({ error: error.message });
  }
});

// Start server
try {
  await fastify.listen({ 
    port: PORT, 
    host: '0.0.0.0' 
  });
  console.log(`🚀 Translator V2 Server running on http://localhost:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}