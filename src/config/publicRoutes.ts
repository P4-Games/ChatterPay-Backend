/** 
 * Public routes constants
*/
export const PUBLIC_ROUTES = [
    "/ping",
    "/nft/metadata/opensea/*",
    "/nfts*",
    "/last_nft*",
    "/nft_info*",
    "/balance/*",
    "/balance_by_phone/"   
]

/**
 * Function that checks if the current route is public or not
 */
export const isPublicRoute = (route: string): boolean => (
    PUBLIC_ROUTES.some(publicRoute => {
        if (publicRoute.includes("*")) {
            return route.startsWith(publicRoute.replace("*", ""))
        }
        return publicRoute === route
    })
)
