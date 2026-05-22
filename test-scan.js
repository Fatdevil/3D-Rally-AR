// Quick test: Create a simple drawing programmatically and send to /api/scan
const { createCanvas } = require('canvas');

async function testScan() {
    // Create a simple test drawing
    const c = createCanvas(800, 566);
    const ctx = c.getContext('2d');
    
    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 800, 566);
    
    // Draw a curvy road (black line)
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(100, 500);
    ctx.quadraticCurveTo(200, 200, 400, 300);
    ctx.quadraticCurveTo(600, 400, 700, 100);
    ctx.stroke();
    
    // Draw a mountain (triangle)
    ctx.fillStyle = '#666666';
    ctx.beginPath();
    ctx.moveTo(500, 250);
    ctx.lineTo(550, 150);
    ctx.lineTo(600, 250);
    ctx.closePath();
    ctx.fill();
    
    // Draw trees (green circles)
    ctx.fillStyle = '#22c55e';
    [
        [150, 350], [180, 320], [250, 280], [350, 250],
        [420, 350], [450, 320]
    ].forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fill();
    });
    
    // Start arrow
    ctx.fillStyle = '#ff0000';
    ctx.font = '24px serif';
    ctx.fillText('▶ START', 50, 510);
    
    // Get base64
    const base64 = c.toDataURL('image/png').split(',')[1];
    
    console.log('Sending test drawing to /api/scan...');
    
    const response = await fetch('http://localhost:8080/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image_base64: base64,
            mode: 'rally',
            style: 'enhance'
        })
    });
    
    const data = await response.json();
    
    if (data.success) {
        console.log('\n✅ SUCCESS! AI interpreted the drawing:\n');
        console.log('Summary:', JSON.stringify(data.summary, null, 2));
        console.log('\nRoads:', data.plan.roads?.length || 0);
        console.log('Mountains:', data.plan.sculpts?.length || 0);
        console.log('Trees:', data.plan.trees?.length || 0);
        console.log('Checkpoints:', data.plan.race?.checkpoints?.length || 0);
        console.log('\nFull plan saved to test-result.json');
        
        require('fs').writeFileSync('test-result.json', JSON.stringify(data.plan, null, 2));
    } else {
        console.log('❌ Error:', data.error);
    }
}

testScan().catch(console.error);
