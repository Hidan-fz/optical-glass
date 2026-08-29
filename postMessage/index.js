// 留言审核云函数 postMessage
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 关键词黑名单（服务端执行，别人改网页代码也绕不过去）
const BAD_WORDS = ['傻逼', 'sb', '煞笔', '草泥马', 'cnm', '操你', '你妈', '妈的', '去死', 'fuck', 'shit', 'bitch'];

function checkBadWord(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/\s+/g, '');
  for (const w of BAD_WORDS) {
    if (w && t.indexOf(w.toLowerCase()) !== -1) return w;
  }
  return null;
}

// TMS 客户端（配了密钥才启用，AI 审核可选）
let tmsClient = null;
const TMS_REGION = process.env.TENCENT_REGION || 'ap-guangzhou';
if (process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY) {
  try {
    const tms = require('tencentcloud-sdk-nodejs').tms.v20201229;
    tmsClient = new tms.Client({
      credential: { secretId: process.env.TENCENT_SECRET_ID, secretKey: process.env.TENCENT_SECRET_KEY },
      region: TMS_REGION,
      profile: { httpProfile: { endpoint: 'tms.tencentcloudapi.com' } }
    });
  } catch (e) {
    console.error('TMS 初始化失败（未安装 tencentcloud-sdk-nodejs？）', e);
  }
}

async function tmsCheck(content) {
  if (!tmsClient) return { enabled: false };
  try {
    const resp = await tmsClient.TextModeration({
      Content: Buffer.from(content, 'utf8').toString('base64')
    });
    return { enabled: true, suggestion: resp && resp.Suggestion, label: resp && resp.Label };
  } catch (e) {
    console.error('TMS 调用失败', e);
    return { enabled: true, error: e.message };
  }
}

exports.main = async (event, context) => {
  const nickname = String(event.nickname || '匿名').slice(0, 20);
  const content = String(event.content || '').trim().slice(0, 500);

  if (!content) return { ok: false, msg: '内容为空' };

  // 1) 关键词过滤
  const bad = checkBadWord(content);
  if (bad) return { ok: false, msg: '内容含不文明用语，已拦截' };

  // 2) TMS AI 审核（Block=违规，Review=疑似，都拦截）
  const tms = await tmsCheck(content);
  if (tms.enabled && !tms.error) {
    if (tms.suggestion === 'Block' || tms.suggestion === 'Review') {
      return { ok: false, msg: '内容涉及敏感信息，已拦截（' + (tms.label || tms.suggestion) + '）' };
    }
  }

  // 3) 写入数据库（云函数有管理员权限，集合只读也能写）
  try {
    const res = await db.collection('messages').add({
      data: { nickname, content, createdAt: db.serverDate() }
    });
    return { ok: true, id: res._id };
  } catch (e) {
    return { ok: false, msg: '写入失败：' + (e.message || e) };
  }
};
