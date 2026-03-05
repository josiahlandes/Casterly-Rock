// Collision Detection - AABB (Axis-Aligned Bounding Box)
export function checkCollision(rect1, rect2) {
    return rect1.x < rect2.x + rect2.width &&
           rect1.x + rect1.width > rect2.x &&
           rect1.y < rect2.y + rect2.height &&
           rect1.y + rect1.height > rect2.y;
}

export function getCollisionRect(obj, width, height) {
    return {
        x: obj.x,
        y: obj.y,
        width: width,
        height: height
    };
}

export function pointInRect(px, py, rect) {
    return px >= rect.x && px <= rect.x + rect.width &&
           py >= rect.y && py <= rect.y + rect.height;
}