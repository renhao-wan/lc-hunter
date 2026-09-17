// 验证 userStatus 里新增的 numSolved / numAcceptedQuestions 在 CN 站是否合法。
// 注意：字段写错会让整个 userStatus 查询 400，进而连 isSignedIn 都拿不到，
// 所以必须单独验一次。
const url = 'https://leetcode.cn/graphql/';

const variants = [
  {
    label: '带 numSolved + numAcceptedQuestions',
    q: `query userStatus { userStatus { isSignedIn username userSlug realName isPremium avatar numSolved numAcceptedQuestions { difficulty count } } }`,
  },
  {
    label: '只带 numSolved',
    q: `query userStatus { userStatus { isSignedIn username numSolved } }`,
  },
  {
    label: '只带 numAcceptedQuestions',
    q: `query userStatus { userStatus { isSignedIn username numAcceptedQuestions { difficulty count } } }`,
  },
  {
    label: '基线（旧字段）',
    q: `query userStatus { userStatus { isSignedIn username userSlug realName isPremium avatar } }`,
  },
];

for (const v of variants) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.cn/' },
      body: JSON.stringify({ query: v.q }),
    });
    const j = await r.json();
    if (j.errors) {
      console.log(`[${v.label}] ❌ ${j.errors.map((e) => e.message).join(' | ')}`);
    } else {
      console.log(`[${v.label}] ✅ ${JSON.stringify(j.data?.userStatus)}`);
    }
  } catch (e) {
    console.log(`[${v.label}] ERR ${e.message}`);
  }
}
