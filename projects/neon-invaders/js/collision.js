// AABB Collision Detection
export function checkCollision(rect1, rect2) {
    return rect1.x < rect2.x + rect2.width &&
           rect1.x + rect1.width > rect2.x &&
           rect1.y < rect2.y + rect2.height &&
           rect1.y + rect1.height > rect2.y;
}

export function pointInRect(x, y, rect) {
    return x >= rect.x && x <= rect.x + rect.width &&
           y >= rect.y && y <= rect.y + rect.height;
}

export function getCenter(rect) {
    return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2
    };
}

export function checkCircleRectCollision(circle, rect) {
    const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
    const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));
    
    const distanceX = circle.x - closestX;
    const distanceY = circle.y - closestY;
    
    return (distanceX * distanceX + distanceY * distanceY) <= (circle.radius * circle.radius);
}
