/** 
 * Public routes constants
*/
export const PUBLIC_ROUTES = [
    "/ping",
    "/nft/metadata/opensea/*",
    "/nfts*",
    "/nft/<id>",
    "/last_nft*",
    "/nft_info*",
    "/balance/*",
]

/**
 * Function that checks if the current route is public or not
 */
export const isPublicRoute = (route: string): boolean => (
    PUBLIC_ROUTES.some(publicRoute => {
        if (publicRoute.includes("*")) {
            return route.startsWith(publicRoute.replace(/\*/g, ""))
        }
        if (publicRoute.includes("<id>")) {
            // Match exactly /nft/ followed by numbers only and nothing after
            const nftIdMatch = route.match(/^\/nft\/(\d+)$/);
            if (!nftIdMatch) return false;

            // Ensure there are no letters in the id
            const id = nftIdMatch[1];
            return /^\d+$/.test(id);
        }
        return publicRoute === route
    })
)

