const API = 'http://localhost:8000/api/v1';

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(`${path} => ${res.status} ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function main() {
  const productChat = await post('/assistant/chat', {
    message: 'عايز أعرف تفاصيل كارت RTX 4060',
  });
  console.log('PRODUCT_CHAT', {
    text: productChat.message.text.slice(0, 180),
    products: (productChat.message.products || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      href: p.href,
      price: p.effective_price,
    })),
  });

  const compareChat = await post('/assistant/chat', {
    conversation_id: productChat.conversation_id,
    guest_token: productChat.guest_token,
    message: 'قارن بين RTX 4060 و RTX 3060',
  });
  console.log('COMPARE_CHAT', {
    text: compareChat.message.text.slice(0, 220),
    products: (compareChat.message.products || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      href: p.href,
    })),
  });

  const buildChat = await post('/assistant/chat', {
    message: 'عايز تجميعة جيمنج بميزانية 45000 جنيه الكيسة فقط',
  });
  console.log('BUILD_CHAT', {
    text: buildChat.message.text.slice(0, 220),
    build_plan: buildChat.message.build_plan
      ? {
          total: buildChat.message.build_plan.total,
          compatibility: buildChat.message.build_plan.compatibility,
          components: (buildChat.message.build_plan.components || []).map((c: any) => ({
            slot_id: c.slot_id,
            product_id: c.product_id,
            name: c.name,
            price: c.effective_price,
          })),
        }
      : null,
  });

  if (buildChat.message.build_plan?.components?.length) {
    const applied = await post('/assistant/apply-build', {
      conversation_id: buildChat.conversation_id,
      guest_token: buildChat.guest_token,
      components: buildChat.message.build_plan.components.map((c: any) => ({
        slot_id: c.slot_id,
        product_id: c.product_id,
        quantity: 1,
      })),
    });
    console.log('APPLY_BUILD', applied);

    const build = await fetch(
      `${API}/builder/${applied.build_id}?guest_token=${encodeURIComponent(applied.guest_token)}`,
      { headers: { Accept: 'application/json' } },
    ).then((r) => r.json());
    console.log('LOAD_BUILD', {
      id: build.data?.id,
      items: (build.data?.items || []).map((i: any) => ({
        slot_id: i.slot_id,
        product_id: i.product_id,
        name: i.name,
      })),
      subtotal: build.data?.subtotal,
      compatibility: build.data?.compatibility?.overall,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
