/** 
 * Business routes constants
*/
export const BUSINESS_ROUTES = [
    "/business*",
    "/execute_contract_call*"
]

/**
 * Function that checks if the current route is business or not
 */
export const isBusinessRoute = (route: string): boolean => (
    BUSINESS_ROUTES.some(businessRoute => {
        if (businessRoute.includes("*")) {
            return route.startsWith(businessRoute.replace(/\*/g, ""))
        }
        if (businessRoute.includes("<id>")) {
            // Match exactly /nft/ followed by numbers only and nothing after
            const nftIdMatch = route.match(/^\/nft\/(\d+)$/);
            if (!nftIdMatch) return false;
            
            // Ensure there are no letters in the id
            const id = nftIdMatch[1];
            return /^\d+$/.test(id);
        }
        return businessRoute === route
    })
)
