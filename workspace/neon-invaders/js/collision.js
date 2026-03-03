// AABB (Axis-Aligned Bounding Box) collision detection

export function checkCollision(rect1, rect2) {
    return rect1.x < rect2.x + rect2.width &&
           rect1.x + rect1.width > rect2.x &&
           rect1.y < rect2.y + rect2.height &&
           rect1.y + rect1.height > rect2.y;
}

// Get collision rectangle for a game object
export function getRect(obj) {
    return {
        x: obj.x,
        y: obj.y,
        width: obj.width || obj.size || 0,
        height: obj.height || obj.size || 0
    };
}

// Check collision between two objects
export function objectsCollide(obj1, obj2) {
    const rect1 = getRect(obj1);
    const rect2 = getRect(obj2);
    return checkCollision(rect1, rect2);
}

// Check if point is inside rectangle
export function pointInRect(px, py, rect) {
    return px >= rect.x && px <= rect.x + rect.width &&
           py >= rect.y && py <= rect.y + rect.height;
};