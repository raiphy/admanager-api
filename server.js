
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://your-app.lovable.app',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true
}));

app.use(express.json());

// Configuração do Google Auth
const getGoogleAuth = () => {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  
  if (!serviceAccountEmail || !privateKey) {
    throw new Error('Credenciais do Service Account não configuradas');
  }
  
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: serviceAccountEmail,
      private_key: privateKey,
    },
    scopes: [
      'https://www.googleapis.com/auth/dfp',
      'https://www.googleapis.com/auth/adexchange.seller.readonly'
    ]
  });
};

// Rota de teste
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    message: 'API RAIPHY AdManager funcionando!'
  });
});

// Teste de conexão com Service Account
app.post('/test-connection', async (req, res) => {
  try {
    console.log('🔍 Testando conexão do Service Account...');
    
    const auth = getGoogleAuth();
    const authClient = await auth.getClient();
    
    // Teste simples de autenticação
    const networkCode = process.env.GOOGLE_ADMANAGER_NETWORK_CODE;
    if (!networkCode) {
      throw new Error('GOOGLE_ADMANAGER_NETWORK_CODE não configurado');
    }
    
    const dfp = google.dfp({ version: 'v202311', auth: authClient });
    
    // Buscar informações da rede
    const networkService = dfp.NetworkService;
    const network = await networkService.getCurrentNetwork();
    
    console.log('✅ Service Account autenticado com sucesso!');
    
    res.json({
      success: true,
      networkInfo: {
        networkCode: network.networkCode,
        displayName: network.displayName,
        timeZone: network.timeZone,
        currencyCode: network.currencyCode,
        publisherId: network.publisherId,
        effectiveRootAdUnitId: network.effectiveRootAdUnitId
      },
      message: 'Service Account conectado com sucesso!'
    });
    
  } catch (error) {
    console.error('❌ Erro ao testar Service Account:', error.message);
    
    let errorMessage = error.message;
    let requiresSetup = false;
    
    if (error.message.includes('não configurad') || error.message.includes('not configured')) {
      requiresSetup = true;
      errorMessage = 'Credenciais do Service Account não configuradas. Configure as variáveis: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, GOOGLE_ADMANAGER_NETWORK_CODE';
    }
    
    res.status(requiresSetup ? 400 : 500).json({
      success: false,
      error: errorMessage,
      requiresSetup
    });
  }
});

// Buscar receita por UTM e domínio
app.post('/admanager-revenue', async (req, res) => {
  try {
    const { utmCampaign, websiteUrl, startDate, endDate } = req.body;
    
    if (!utmCampaign || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetros obrigatórios: utmCampaign, startDate, endDate'
      });
    }
    
    console.log(`💰 Buscando receita para UTM: "${utmCampaign}"`);
    console.log(`📅 Período: ${startDate} até ${endDate}`);
    console.log(`🌐 Website: ${websiteUrl || 'Não especificado'}`);
    
    const auth = getGoogleAuth();
    const authClient = await auth.getClient();
    const dfp = google.dfp({ version: 'v202311', auth: authClient });
    
    // Criar relatório de receita
    const reportJob = {
      reportQuery: {
        dimensions: ['DATE', 'AD_UNIT_NAME'],
        columns: ['AD_EXCHANGE_REVENUE'],
        dateRangeType: 'CUSTOM_DATE',
        startDate: {
          year: parseInt(startDate.split('-')[0]),
          month: parseInt(startDate.split('-')[1]),
          day: parseInt(startDate.split('-')[2])
        },
        endDate: {
          year: parseInt(endDate.split('-')[0]),
          month: parseInt(endDate.split('-')[1]),
          day: parseInt(endDate.split('-')[2])
        },
        statement: {
          query: `WHERE AD_UNIT_NAME LIKE '%${utmCampaign}%'`
        }
      }
    };
    
    // Executar relatório
    const reportService = dfp.ReportService;
    const reportJobResult = await reportService.runReportJob(reportJob);
    
    // Aguardar conclusão do relatório
    let isReady = false;
    let attempts = 0;
    const maxAttempts = 30;
    
    while (!isReady && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 segundos
      
      const status = await reportService.getReportJobStatus(reportJobResult.id);
      isReady = status === 'COMPLETED';
      attempts++;
      
      console.log(`📊 Aguardando relatório... tentativa ${attempts}/${maxAttempts}`);
    }
    
    if (!isReady) {
      throw new Error('Timeout ao gerar relatório do AdManager');
    }
    
    // Baixar dados do relatório
    const reportData = await reportService.getReportDownloadURL(reportJobResult.id, 'CSV_DUMP');
    const csvResponse = await fetch(reportData.url);
    const csvData = await csvResponse.text();
    
    // Processar CSV e somar receita
    const lines = csvData.split('\n').slice(1); // Pular header
    let totalRevenue = 0;
    
    for (const line of lines) {
      if (line.trim()) {
        const columns = line.split(',');
        const revenue = parseFloat(columns[2]) || 0; // AD_EXCHANGE_REVENUE
        totalRevenue += revenue;
      }
    }
    
    console.log(`✅ Receita total encontrada: $${totalRevenue.toFixed(2)}`);
    
    res.json({
      success: true,
      totalRevenue: totalRevenue,
      source: 'real',
      utmCampaign,
      websiteUrl,
      period: { startDate, endDate },
      recordsFound: lines.length - 1
    });
    
  } catch (error) {
    console.error('❌ Erro ao buscar receita:', error.message);
    
    // Retornar dados mock em caso de erro para não quebrar o frontend
    res.json({
      success: true,
      totalRevenue: 0,
      source: 'mock',
      error: error.message,
      requiresAuth: error.message.includes('auth') || error.message.includes('credential')
    });
  }
});

// Middleware de erro global
app.use((error, req, res, next) => {
  console.error('❌ Erro na API:', error);
  res.status(500).json({
    success: false,
    error: 'Erro interno do servidor',
    message: error.message
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 API RAIPHY AdManager rodando na porta ${PORT}`);
  console.log(`📡 Endpoints disponíveis:`);
  console.log(`   GET  /health - Status da API`);
  console.log(`   POST /test-connection - Testar Service Account`);
  console.log(`   POST /admanager-revenue - Buscar receita`);
});

module.exports = app;
