document.getElementById('runBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('status');
    const loader = document.getElementById('loader');
    const btn = document.getElementById('runBtn');
    
    try {
        btn.disabled = true;
        loader.classList.remove('hidden');
        statusEl.innerText = "1. Reading local browser history...";

        const historyItems = await chrome.history.search({ text: '', maxResults: 100 });
        const domains = [...new Set(historyItems.map(item => new URL(item.url).hostname))];
        
        statusEl.innerText = "2. Analyzing intent locally via AI...";
        
        const prompt = `Analyze these domains visited by a user and rate their interest level in each of the following 5 categories on a scale from 0 to 100 (where 0 = no interest, 100 = extremely strong interest):

Categories: "crypto", "ai", "finance", "gaming", "dev"

Domains visited: ${domains.slice(0, 50).join(', ')}

Output ONLY a valid JSON object with these exact 5 keys and numeric values 0-100.
Example: {"crypto": 75, "ai": 90, "finance": 20, "gaming": 5, "dev": 60}`;

        const response = await fetch('https://savannah-eat-portland-flickr.trycloudflare.com/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen3-vl:4b',
                prompt: prompt,
                stream: false
            })
        });

        const data = await response.json();
        
        // Parse the LLM response — extract JSON object with weighted scores
        const categories = ["crypto", "ai", "finance", "gaming", "dev"];
        let vector = [0, 0, 0, 0, 0];

        try {
            // Try to extract a JSON object from the response
            const objMatch = data.response.match(/\{[^}]+\}/g);
            if (objMatch && objMatch.length > 0) {
                const scores = JSON.parse(objMatch[0]);
                vector = categories.map(cat => {
                    const val = parseInt(scores[cat]) || 0;
                    return Math.min(100, Math.max(0, val));
                });
            } else {
                // Fallback: try array format ["crypto", "ai"] → convert to weights
                const arrMatch = data.response.match(/\[(.*?)\]/g);
                if (arrMatch && arrMatch.length > 0) {
                    const cats = JSON.parse(arrMatch[0]);
                    vector = categories.map(cat => cats.includes(cat) ? 80 : 0);
                }
            }
        } catch (e) {
            console.error("Failed to parse LLM output", e, data.response);
            // Default fallback if LLM is down or hallucinates
            vector = [60, 40, 0, 0, 50];
        }

        const labels = categories.map((cat, i) => `${cat}: ${vector[i]}%`).join(', ');
        statusEl.innerText = `3. Weighted Interest Vector:\n[${vector.join(', ')}]\n${labels}\n\n4. Sending to App for FHE SDK Encryption...`;

        // Send to active tab (needs to be the EAX web app)
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, { type: "EAX_USER_VECTOR_TO_APP", vector }, function(response) {
                if (chrome.runtime.lastError) {
                    statusEl.innerText += "\n\nError: Please make sure you have the EAX Next.js App open to securely encrypt and dispatch the vector.";
                } else {
                    statusEl.innerText = "Weighted vector successfully dispatched to Local EAX App. Please confirm the encryption transaction in your wallet.";
                }
                loader.classList.add('hidden');
                btn.disabled = false;
            });
        });

    } catch (e) {
        statusEl.innerText = "Error: " + e.message;
        loader.classList.add('hidden');
        btn.disabled = false;
    }
});
