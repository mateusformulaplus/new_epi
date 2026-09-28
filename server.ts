import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { getDatabaseStatus, getPrismaClient } from './prisma-client.js';
import { getStockAlertType } from './notification-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// CORS configuration for Vercel / cross-origin requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Initialize Prisma Client
const prisma = getPrismaClient();
const useDatabase = prisma !== null;

if (useDatabase) {
  console.log('🗄️  Modo: PostgreSQL via Prisma (Supabase) — dados persistidos no banco.');
} else {
  console.log('📦  Modo: In-Memory (banco não configurado) — dados voláteis (reiniciam com o servidor).');
}

// =================== STATE ===================
let passwordResetTokens: Record<string, { email: string; expires: number }> = {};

// =================== UTILITY FUNCTIONS ===================
function getEPIStatus(currentQty: number, minQty: number): EPIStatus {
  if (currentQty <= 0) return 'out_of_stock';
  if (currentQty <= minQty) return 'low';
  return 'normal';
}

// Map Prisma EPI status string to TypeScript EPIStatus
function mapDbStatusToEPIStatus(dbStatus: string): EPIStatus {
  if (dbStatus === 'esgotado') return 'out_of_stock';
  if (dbStatus === 'baixo') return 'low';
  return 'normal';
}

function mapEPIStatusToDb(status: EPIStatus): string {
  if (status === 'out_of_stock') return 'esgotado';
  if (status === 'low') return 'baixo';
  return 'normal';
}

// Map Prisma EPI model → TypeScript EPIItem
function mapPrismaEPI(e: any): EPIItem {
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    category: e.category as any,
    unit: e.unit,
    currentQty: e.currentQty,
    minQty: e.minQty,
    location: e.location,
    manufacturer: e.manufacturer ?? undefined,
    notes: e.notes ?? undefined,
    updatedAt: e.updatedAt instanceof Date ? e.updatedAt.toISOString() : e.updatedAt,
    status: mapDbStatusToEPIStatus(e.status),
    businessUnitId: e.businessUnitId ?? undefined,
    businessUnitName: e.businessUnit?.name ?? undefined,
    businessUnitType: e.businessUnit?.type as any,
  };
}

// Map Prisma User model → TypeScript User
function mapPrismaUser(u: any): User {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as any,
    status: u.status as any,
    createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt,
    lastLogin: u.lastLogin ? (u.lastLogin instanceof Date ? u.lastLogin.toISOString() : u.lastLogin) : undefined,
    department: u.department ?? undefined,
    businessUnitId: u.businessUnitId ?? undefined,
    businessUnitName: u.businessUnit?.name ?? undefined,
    businessUnitType: u.businessUnit?.type as any,
  };
}

// Map Prisma Movement → TypeScript Movement
function mapPrismaMovement(m: any): Movement {
  return {
    id: m.id,
    epiId: m.epiId,
    epiCode: m.epiCode,
    epiName: m.epiName,
    type: m.type as any,
    quantity: m.quantity,
    responsibleId: m.responsibleId ?? '',
    responsibleName: m.responsibleName,
    reason: m.reason ?? '',
    recipient: m.recipient ?? undefined,
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    notes: m.notes ?? undefined,
    businessUnitId: m.businessUnitId ?? undefined,
    businessUnitName: m.businessUnit?.name ?? undefined,
  };
}

// Map Prisma AuditLog → TypeScript AuditLog
function mapPrismaLog(l: any): AuditLog {
  return {
    id: l.id,
    timestamp: l.timestamp instanceof Date ? l.timestamp.toISOString() : l.timestamp,
    userId: l.userId ?? '',
    userName: l.userName,
    userRole: l.userRole as any,
    action: l.action,
    details: l.details,
    ip: l.ip ?? undefined,
  };
}

// Map Prisma Notification → TypeScript EmailNotification
function mapPrismaNotification(n: any): EmailNotification {
  return {
    id: n.id,
    timestamp: n.timestamp instanceof Date ? n.timestamp.toISOString() : n.timestamp,
    recipient: n.recipient,
    subject: n.subject,
    body: n.body,
    type: n.type as any,
    read: n.read,
  };
}

// Utility to add an audit log in the database
async function addAuditLog(userId: string, userName: string, userRole: any, action: string, details: string) {
  if (!useDatabase || !prisma) {
    console.warn('⚠️ Banco não disponível; não foi possível registrar o audit log.');
    return;
  }

  try {
    await prisma.auditLog.create({
      data: {
        userId,
        userName,
        userRole,
        action,
        details,
        ip: '127.0.0.1',
      },
    });
  } catch (err) {
    console.error('Erro ao salvar audit log:', err);
  }
}

// Helper function to send email via Resend API
async function sendResendEmail(to: string, subject: string, textBody: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ RESEND_API_KEY não configurada no .env. Ignorando envio real de e-mail.');
    return;
  }

  // O domínio gratuito do Resend (onboarding@resend.dev) envia apenas para o e-mail cadastrado na conta.
  // Faremos um fallback inteligente caso os e-mails dos administradores não sejam autorizados na Sandbox.
  const toList = to.split(',').map(email => email.trim());

  // Formata o corpo do e-mail em HTML
  const htmlBody = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
      <h2 style="color: #0f2c59; border-bottom: 2px solid #059669; padding-bottom: 10px; margin-top: 0; display: flex; align-items: center; gap: 8px;">
        🛡️ FORMULA EPI - Alerta de Estoque
      </h2>
      <div style="white-space: pre-wrap; font-size: 14px; color: #334155; line-height: 1.6; background-color: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #f1f5f9;">${textBody.replace(/\n/g, '<br>')}</div>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">Esta é uma notificação automática gerada pelo sistema de Gestão de Estoque FormulaEpi.</p>
    </div>
  `;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'FormulaEPI <onboarding@resend.dev>',
        to: toList,
        subject: subject,
        html: htmlBody
      })
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`✉️ E-mail enviado com sucesso via Resend! ID: ${data.id}`);
    } else {
      const errText = await response.text();
      console.error(`❌ Erro no envio de e-mail via Resend (Status ${response.status}):`, errText);
    }
  } catch (err) {
    console.error('❌ Falha de conexão ao tentar enviar e-mail via Resend:', err);
  }
}

// Utility to trigger auto-email notification
async function triggerEmailNotification(epi: EPIItem, previousQty: number) {
  const type = getStockAlertType(epi.currentQty, previousQty, epi.minQty);
  let subject = '';
  let body = '';

  let recipientEmail = process.env.RESEND_TO_EMAIL || 'formulaplus.developer@gmail.com';

  if (type === 'out_of_stock') {
    subject = `🚨 URGENTE: Produto Esgotado - ${epi.name}`;
    body = `Atenção Administrador,\n\nO produto abaixo ESGOTOU COMPLETAMENTE no estoque:\n\n• Produto: ${epi.name} (${epi.code})\n• Categoria: ${epi.category}\n• Quantidade Atual: 0 ${epi.unit}\n• Quantidade Mínima: ${epi.minQty} ${epi.unit}\n• Localização: ${epi.location}\n• Data do Alerta: ${new Date().toLocaleString('pt-BR')}\n\nPor favor, providencie a emissão do pedido de compra de reposição.`;
  } else if (type === 'low_stock') {
    subject = `⚠️ ALERTA: Estoque Mínimo Atingido - ${epi.name}`;
    body = `Atenção Administrador,\n\nO produto abaixo atingiu ou ficou abaixo da quantidade mínima configurada:\n\n• Produto: ${epi.name} (${epi.code})\n• Categoria: ${epi.category}\n• Quantidade Atual: ${epi.currentQty} ${epi.unit}\n• Quantidade Mínima: ${epi.minQty} ${epi.unit}\n• Localização: ${epi.location}\n• Data do Alerta: ${new Date().toLocaleString('pt-BR')}\n\nRecomenda-se providenciar o reabastecimento antes que o item esgote.`;
  }

  if (type) {
    if (useDatabase && prisma) {
      try {
        await prisma.notification.create({
          data: {
            recipient: recipientEmail,
            subject,
            body,
            type,
            read: false,
            epiId: epi.id,
          },
        });
      } catch (err) {
        console.error('Erro ao salvar notificação:', err);
      }
    } else {
      console.warn('⚠️ Banco não disponível; a notificação não foi persistida.');
    }

    // Dispara o envio real de e-mail em background via Resend API
    sendResendEmail(recipientEmail, subject, body);

    await addAuditLog('system', 'Sistema de Notificações', 'admin', `Notificação Enviada (${type})`, `Disparado e-mail para ${recipientEmail}: ${subject}`);
  }
}


// =================== API ROUTES ===================

// Database Status
app.get('/api/database-status', (_req, res) => {
  res.json(getDatabaseStatus());
});

// Reset Demo Data
app.post('/api/reset-demo-data', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado. Configure DATABASE_URL para restaurar os dados.' });
  }

  try {
    await prisma.notification.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.movement.deleteMany();
    await prisma.ePI.deleteMany();
    await prisma.user.deleteMany();

    const { execSync } = await import('child_process');
    execSync('npx tsx prisma/seed.ts', { stdio: 'inherit', cwd: __dirname });

    return res.json({ success: true, message: 'Banco de dados restaurado com dados iniciais!' });
  } catch (err) {
    console.error('Erro ao resetar banco:', err);
    return res.status(500).json({ error: 'Erro ao resetar banco de dados.' });
  }
});

// =================== BUSINESS UNITS ===================

app.get('/api/business-units', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    let units = await prisma.businessUnit.findMany({ orderBy: { createdAt: 'asc' } });
    const hasMatriz = units.some((u) => u.type === 'matriz');
    if (!hasMatriz) {
      const defaultMatriz = await prisma.businessUnit.create({
        data: {
          id: 'bu-matriz',
          name: 'Matriz',
          code: 'MAT',
          type: 'matriz',
          active: true,
        },
      });
      units.unshift(defaultMatriz);
    }
    return res.json(units);
  } catch (err) {
    console.error('Erro ao buscar unidades:', err);
    return res.status(500).json({ error: 'Erro ao buscar unidades do banco.' });
  }
});

app.post('/api/business-units', async (req, res) => {
  const { name, type = 'filial' } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'O nome da unidade é obrigatório.' });
  }

  const normalizedName = name.trim();
  const unitType = type === 'matriz' ? 'matriz' : 'filial';
  const code = `BU${Date.now().toString().slice(-4)}`.toUpperCase();

  try {
    const created = await prisma.businessUnit.create({
      data: {
        name: normalizedName,
        type: unitType,
        code,
        active: true,
      },
    });
    return res.status(201).json(created);
  } catch (err) {
    console.error('Erro ao criar unidade:', err);
    return res.status(500).json({ error: 'Erro ao criar unidade no banco.' });
  }
});

app.delete('/api/business-units/:id', async (req, res) => {
  const { id } = req.params;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  if (id === 'bu-matriz' || id === 'matriz') {
    return res.status(400).json({ error: 'A matriz não pode ser removida.' });
  }

  try {
    const unitEpis = await prisma.ePI.findMany({
      where: { businessUnitId: id },
      select: { id: true },
    });
    const epiIds = unitEpis.map((e) => e.id);

    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { epiId: { in: epiIds } } }),
      prisma.movement.deleteMany({ where: { businessUnitId: id } }),
      prisma.ePI.deleteMany({ where: { businessUnitId: id } }),
      prisma.user.deleteMany({ where: { businessUnitId: id } }),
      prisma.businessUnit.delete({ where: { id } }),
    ]);

    return res.json({ success: true, message: 'Unidade e todos os dados vinculados excluídos com sucesso.' });
  } catch (err) {
    console.error('Erro ao excluir unidade:', err);
    return res.status(500).json({ error: 'Erro ao excluir unidade no banco.' });
  }
});

// =================== AUTH ===================

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const expiresInMs = 8 * 60 * 60 * 1000;
  const expiresAt = Date.now() + expiresInMs;

  try {
    const dbUser = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!dbUser || dbUser.password !== password) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
    }

    if (dbUser.status === 'inactive') {
      return res.status(403).json({ error: 'Conta desativada. Entre em contato com um administrador.' });
    }

    await prisma.user.update({ where: { id: dbUser.id }, data: { lastLogin: new Date() } }).catch(() => {});
    await addAuditLog(dbUser.id, dbUser.name, dbUser.role, 'Login Realizado', `Sessão autenticada via e-mail: ${dbUser.email}`).catch(() => {});

    const token = `fmt_${dbUser.id}_${expiresAt}`;
    return res.json({
      user: mapPrismaUser({ ...dbUser, lastLogin: new Date() }),
      token,
      expiresAt,
    });
  } catch (err) {
    console.error('Erro no login via banco:', err);
    return res.status(500).json({ error: 'Erro ao autenticar no banco de dados.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de sessão não fornecido.' });
  }

  const token = authHeader.split(' ')[1];
  const parts = token.split('_');

  if (parts.length < 3 || parts[0] !== 'fmt') {
    return res.status(401).json({ error: 'Token com formato inválido.' });
  }

  const userId = parts[1];
  const expiresAt = Number(parts[2]);

  if (Date.now() > expiresAt) {
    return res.status(401).json({ error: 'Sessão expirada. Por favor, faça login novamente.' });
  }

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status === 'inactive') {
      return res.status(401).json({ error: 'Usuário inválido ou inativo.' });
    }
    return res.json({ user: mapPrismaUser(user), expiresAt });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao validar token de sessão.' });
  }
});

app.post('/api/auth/recover-password', async (req, res) => {
  const { email } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const dbUser = await prisma.user.findUnique({ where: { email: (email || '').toLowerCase() } });
  if (!dbUser) return res.status(404).json({ error: 'Nenhum usuário cadastrado com este e-mail.' });

  const user = mapPrismaUser(dbUser);
  const token = Math.floor(100000 + Math.random() * 900000).toString();
  passwordResetTokens[token] = { email: user.email, expires: Date.now() + 15 * 60 * 1000 };

  await prisma.notification.create({
    data: {
      recipient: user.email,
      subject: '🔑 Código para Recuperação de Senha - Sistema de EPIs',
      body: `Olá ${user.name},\n\nRecebemos uma solicitação de redefinição de senha para sua conta.\n\nSeu código de verificação é: ${token}\nEste código é válido por 15 minutos.\n\nSe você não solicitou a alteração, ignore esta mensagem.`,
      type: 'general',
      read: false,
    },
  });

  await addAuditLog(user.id, user.name, user.role, 'Solicitação de Recuperação de Senha', `Código de recuperação gerado para ${user.email}`);

  return res.json({
    success: true,
    message: 'E-mail de recuperação enviado! Verifique seu código na central de notificações.',
    tokenDemo: token,
  });
});


app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});



app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  const tokenData = passwordResetTokens[token];
  if (!tokenData || tokenData.expires < Date.now()) return res.status(400).json({ error: 'Código de recuperação inválido ou expirado.' });

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const dbUser = await prisma.user.findUnique({ where: { email: tokenData.email } });
  if (!dbUser) return res.status(404).json({ error: 'Usuário não encontrado.' });

  await prisma.user.update({ where: { id: dbUser.id }, data: { password: newPassword } });
  await addAuditLog(dbUser.id, dbUser.name, dbUser.role, 'Senha Redefinida', 'Senha alterada com sucesso via código de verificação.');
  delete passwordResetTokens[token];
  return res.json({ success: true, message: 'Senha redefinida com sucesso! Você já pode realizar o login.' });
});

// =================== USERS ===================

app.get('/api/users', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const dbUsers = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: { businessUnit: true },
    });
    return res.json(dbUsers.map(mapPrismaUser));
  } catch (err) {
    console.error('Erro ao buscar usuários:', err);
    return res.status(500).json({ error: 'Erro ao buscar usuários do banco.' });
  }
});

app.post('/api/users', async (req, res) => {
  const { name, email, role, department, businessUnitId } = req.body;
  if (!name || !email || !role) return res.status(400).json({ error: 'Nome, e-mail e perfil de acesso são obrigatórios.' });

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(400).json({ error: 'Já existe um usuário cadastrado com este e-mail.' });

    const newUser = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        password: 'formulaplus',
        role,
        status: 'active',
        department: department || 'Operacional',
        businessUnitId: businessUnitId || null,
      },
    });
    await addAuditLog('admin', 'Administrador', 'admin', 'Novo Usuário Criado', `Criado usuário ${name} (${email}) com perfil ${role}.`);
    return res.status(201).json(mapPrismaUser(newUser));
  } catch (err) {
    console.error('Erro ao criar usuário:', err);
    return res.status(500).json({ error: 'Erro ao criar usuário no banco.' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, role, status, department, businessUnitId } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(email && { email: email.toLowerCase() }),
        ...(role && { role }),
        ...(status && { status }),
        ...(department !== undefined && { department }),
        ...(businessUnitId !== undefined && { businessUnitId: businessUnitId === '' ? null : businessUnitId }),
      },
    });
    await addAuditLog('admin', 'Administrador', 'admin', 'Usuário Atualizado', `Atualizadas informações do usuário ${updated.name} (${updated.email}).`);
    return res.json(mapPrismaUser(updated));
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Usuário não encontrado.' });
    console.error('Erro ao atualizar usuário:', err);
    return res.status(500).json({ error: 'Erro ao atualizar usuário no banco.' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const deleted = await prisma.user.delete({ where: { id } });
    await addAuditLog('admin', 'Administrador', 'admin', 'Usuário Excluído', `Removido usuário ${deleted.name} (${deleted.email}).`);
    return res.json({ success: true, message: 'Usuário excluído com sucesso.' });
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Usuário não encontrado.' });
    return res.status(500).json({ error: 'Erro ao excluir usuário do banco.' });
  }
});

// =================== EPIs ===================

app.get('/api/epis', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const dbEpis = await prisma.ePI.findMany({ orderBy: { createdAt: 'desc' } });
    return res.json(dbEpis.map(mapPrismaEPI));
  } catch (err) {
    console.error('Erro ao buscar EPIs:', err);
    return res.status(500).json({ error: 'Erro ao buscar EPIs do banco.' });
  }
});

app.post('/api/epis', async (req, res) => {
  const { code, name, category, unit, currentQty, minQty, location, manufacturer, notes, userId, userName, userRole, businessUnitId } = req.body;
  if (!name || !category || !unit) return res.status(400).json({ error: 'Nome, categoria e unidade de medida são obrigatórios.' });

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const initialQty = Number(currentQty) || 0;
  const minimumQty = Number(minQty) || 0;
  const status = getEPIStatus(initialQty, minimumQty);

  try {
    let autoCode = code;
    if (!autoCode) {
      let suffix = 1;
      let isUnique = false;
      while (!isUnique) {
        const generated = `EPI-${suffix.toString().padStart(3, '0')}`;
        const existing = await prisma.ePI.findUnique({ where: { code: generated } });
        if (!existing) {
          autoCode = generated;
          isUnique = true;
        } else {
          suffix++;
        }
      }
    }

    const newEpi = await prisma.ePI.create({
      data: {
        code: autoCode,
        name,
        category,
        unit,
        currentQty: initialQty,
        minQty: minimumQty,
        location: location || 'Armazém Central',
        manufacturer: manufacturer || null,
        notes: notes || null,
        status: mapEPIStatusToDb(status),
        businessUnitId: businessUnitId || null,
      },
    });

    const mappedEpi = mapPrismaEPI(newEpi);
    await addAuditLog(userId || 'admin', userName || 'Usuário', userRole || 'admin', 'Cadastro de Novo EPI', `Cadastrado EPI ${newEpi.name} (${newEpi.code}) com estoque inicial de ${initialQty} ${newEpi.unit}.`);

    if (status !== 'normal') await triggerEmailNotification(mappedEpi, initialQty + 1);
    return res.status(201).json(mappedEpi);
  } catch (err) {
    console.error('Erro ao criar EPI:', err);
    return res.status(500).json({ error: 'Erro ao criar EPI no banco.' });
  }
});

app.put('/api/epis/:id', async (req, res) => {
  const { id } = req.params;
  const { code, name, category, unit, currentQty, minQty, location, manufacturer, notes, userId, userName, userRole, businessUnitId } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const existing = await prisma.ePI.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'EPI não encontrado.' });

    const previousQty = existing.currentQty;
    const newCurrentQty = currentQty !== undefined ? Number(currentQty) : existing.currentQty;
    const newMinQty = minQty !== undefined ? Number(minQty) : existing.minQty;
    const newStatus = getEPIStatus(newCurrentQty, newMinQty);

    const updated = await prisma.ePI.update({
      where: { id },
      data: {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category }),
        ...(unit !== undefined && { unit }),
        currentQty: newCurrentQty,
        minQty: newMinQty,
        ...(location !== undefined && { location }),
        ...(manufacturer !== undefined && { manufacturer }),
        ...(notes !== undefined && { notes }),
        status: mapEPIStatusToDb(newStatus),
        ...(businessUnitId !== undefined && { businessUnitId: businessUnitId === '' ? null : businessUnitId }),
      },
    });

    const mappedEpi = mapPrismaEPI(updated);
    await addAuditLog(userId || 'admin', userName || 'Usuário', userRole || 'admin', 'Edição de EPI', `Alteradas configurações do EPI ${updated.name} (${updated.code}). Mínimo: ${updated.minQty}, Qtd: ${updated.currentQty}.`);
    if (newStatus !== 'normal') await triggerEmailNotification(mappedEpi, previousQty);
    return res.json(mappedEpi);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'EPI não encontrado.' });
    console.error('Erro ao atualizar EPI:', err);
    return res.status(500).json({ error: 'Erro ao atualizar EPI no banco.' });
  }
});

app.delete('/api/epis/:id', async (req, res) => {
  const { id } = req.params;
  const { userId, userName, userRole } = req.query;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const deleted = await prisma.ePI.delete({ where: { id } });
    await addAuditLog((userId as string) || 'admin', (userName as string) || 'Administrador', (userRole as any) || 'admin', 'Exclusão de EPI', `Excluído o item ${deleted.name} (${deleted.code}) do catálogo.`);
    return res.json({ success: true, message: 'EPI excluído com sucesso.' });
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'EPI não encontrado.' });
    return res.status(500).json({ error: 'Erro ao excluir EPI do banco.' });
  }
});

// =================== MOVEMENTS ===================

app.get('/api/movements', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const dbMovements = await prisma.movement.findMany({ orderBy: { date: 'desc' } });
    return res.json(dbMovements.map(mapPrismaMovement));
  } catch (err) {
    console.error('Erro ao buscar movimentos:', err);
    return res.status(500).json({ error: 'Erro ao buscar movimentos do banco.' });
  }
});

app.post('/api/movements', async (req, res) => {
  const { epiId, type, quantity, responsibleId, responsibleName, reason, recipient, notes, businessUnitId } = req.body;
  if (!epiId || !type || !quantity || quantity <= 0) return res.status(400).json({ error: 'Produto, tipo de movimentação e quantidade válida são obrigatórios.' });

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const numQty = Number(quantity);

  try {
    const epiDb = await prisma.ePI.findUnique({ where: { id: epiId } });
    if (!epiDb) return res.status(404).json({ error: 'EPI selecionado não existe no sistema.' });

    if (type === 'saida' && epiDb.currentQty < numQty) {
      return res.status(400).json({ error: `Estoque insuficiente! Saldo atual de ${epiDb.name}: ${epiDb.currentQty} ${epiDb.unit}. Tentativa de saída: ${numQty} ${epiDb.unit}.` });
    }

    const previousQty = epiDb.currentQty;
    const newQty = type === 'entrada' ? epiDb.currentQty + numQty : epiDb.currentQty - numQty;
    const newStatus = getEPIStatus(newQty, epiDb.minQty);

    const [newMovement, updatedEpi] = await prisma.$transaction([
      prisma.movement.create({
        data: {
          epiId: epiDb.id,
          epiCode: epiDb.code,
          epiName: epiDb.name,
          type,
          quantity: numQty,
          responsibleId: responsibleId || null,
          responsibleName: responsibleName || 'Operador do Sistema',
          reason: reason || (type === 'entrada' ? 'Reposição de Estoque' : 'Entrega para Setor'),
          recipient: recipient || (type === 'entrada' ? 'Almoxarifado' : 'Equipe Operacional'),
          notes: notes || null,
          businessUnitId: businessUnitId || null,
        },
      }),
      prisma.ePI.update({
        where: { id: epiId },
        data: {
          currentQty: newQty,
          status: mapEPIStatusToDb(newStatus),
        },
      }),
    ]);

    const mappedMovement = mapPrismaMovement(newMovement);
    const mappedEpi = mapPrismaEPI(updatedEpi);

    const actionText = type === 'entrada' ? 'Entrada de Estoque' : 'Saída de Estoque';
    const detailText = `${type.toUpperCase()}: ${numQty} ${updatedEpi.unit} de ${updatedEpi.name} (${updatedEpi.code}). Saldo atualizado para: ${newQty} ${updatedEpi.unit}.`;
    await addAuditLog(responsibleId || 'user', responsibleName || 'Usuário', 'operador', actionText, detailText);

    await triggerEmailNotification(mappedEpi, previousQty);

    return res.status(201).json({ movement: mappedMovement, updatedEpi: mappedEpi });
  } catch (err) {
    console.error('Erro ao criar movimento:', err);
    return res.status(500).json({ error: 'Erro ao registrar movimentação no banco.' });
  }
});

// =================== NOTIFICATIONS ===================

app.get('/api/notifications', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const dbNotifs = await prisma.notification.findMany({ orderBy: { timestamp: 'desc' } });
    return res.json(dbNotifs.map(mapPrismaNotification));
  } catch (err) {
    console.error('Erro ao buscar notificações:', err);
    return res.status(500).json({ error: 'Erro ao buscar notificações do banco.' });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  const { id } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    if (id) {
      await prisma.notification.update({ where: { id }, data: { read: true } });
    } else {
      await prisma.notification.updateMany({ data: { read: true } });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Erro ao marcar notificação como lida:', err);
    return res.status(500).json({ error: 'Erro ao atualizar notificação.' });
  }
});

// =================== AUDIT LOGS ===================

app.get('/api/logs', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const dbLogs = await prisma.auditLog.findMany({ orderBy: { timestamp: 'desc' } });
    return res.json(dbLogs.map(mapPrismaLog));
  } catch (err) {
    console.error('Erro ao buscar logs:', err);
    return res.status(500).json({ error: 'Erro ao buscar logs do banco.' });
  }
});

// =================== VITE SERVER ===================

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      root: path.resolve(__dirname, '../frontend'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, '../dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 API Status: http://localhost:${PORT}/api/database-status`);
    console.log(`🗄️  Database: ${useDatabase ? 'PostgreSQL (Supabase)' : 'In-Memory (Modo Demo)'}\n`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
