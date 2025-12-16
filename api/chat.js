export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch('http://165.227.128.12/v1/chat-messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer app-JD3LSwu8htitgBCJI6ihFEEY',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to connect to chat service' });
  }
}
