// AABB (Axis-Aligned Bounding Box) Collision Detection

import { CANVAS } from './config.js';

/**
 * Check if two rectangles intersect
 * @param {Object} a - First rectangle {x, y, width, height}
 * @param {Object} b - Second rectangle {x, y, width, height}
 * @returns {boolean} True if rectangles intersect
 */
export function checkCollision(a, b) {
    return a.x < b.x + b.width &&
           a.x + a.width > b.x &&
           a.y < b.y + b.height &&
           a.y + a.height > b.y;
}

/**
 * Check if a point is inside a rectangle
 * @param {number} x - Point x coordinate
 * @param {number} y - Point y coordinate
 * @param {Object} rect - Rectangle {x, y, width, height}
 * @returns {boolean} True if point is inside rectangle
 */
export function pointInRect(x, y, rect) {
    return x >= rect.x && x <= rect.x + rect.width &&
           y >= rect.y && y <= rect.y + rect.height;
}

/**
 * Check if a circle intersects with a rectangle
 * @param {Object} circle - Circle {x, y, radius}
 * @param {Object} rect - Rectangle {x, y, width, height}
 * @returns {boolean} True if circle and rectangle intersect
 */
export function circleRectCollision(circle, rect) {
    // Find the closest point on the rectangle to the circle center
    const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
    const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));
    
    // Calculate distance from circle center to closest point
    const distanceX = circle.x - closestX;
    const distanceY = circle.y - closestY;
    
    // Check if distance is less than radius
    return (distanceX * distanceX + distanceY * distanceY) < (circle.radius * circle.radius);
}

/**
 * Get collision rectangle for a game object
 * @param {Object} obj - Game object with x, y, width, height properties
 * @returns {Object} Collision rectangle
 */
export function getCollisionRect(obj) {
    return {
        x: obj.x,
        y: obj.y,
        width: obj.width || obj.size || 0,
        height: obj.height || obj.size || 0
    };
}

/**
 * Check if an object is within the canvas bounds
 * @param {Object} obj - Object with x, y, width, height
 * @returns {boolean} True if fully within bounds
 */
export function isWithinBounds(obj) {
    return obj.x >= 0 &&
           obj.x + (obj.width || 0) <= CANVAS.WIDTH &&
           obj.y >= 0 &&
           obj.y + (obj.height || 0) <= CANVAS.HEIGHT;
}

/**
 * Check if an object is partially within the canvas bounds
 * @param {Object} obj - Object with x, y, width, height
 * @returns {boolean} True if at least partially within bounds
 */
export function isPartiallyWithinBounds(obj) {
    return obj.x < CANVAS.WIDTH &&
           obj.x + (obj.width || 0) > 0 &&
           obj.y < CANVAS.HEIGHT &&
           obj.y + (obj.height || 0) > 0;
}

// Export singleton for convenience
export const collision = {
    checkCollision,
    pointInRect,
    circleRectCollision,
    getCollisionRect,
    isWithinBounds,
    isPartiallyWithinBounds
};