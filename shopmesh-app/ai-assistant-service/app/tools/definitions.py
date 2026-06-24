TOOL_DEFINITIONS = [
    {
        "toolSpec": {
            "name": "search_products",
            "description": (
                "Search the ShopMesh product catalog by keyword, category, or price range. "
                "Use this when the user wants to browse or find products. "
                "Returns a list of matching products with price, stock, rating, and description. "
                "Default limit is 10; maximum is 20."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Free-text search query (searches product name and description)"
                        },
                        "category": {
                            "type": "string",
                            "description": (
                                "Product category filter. "
                                "Valid values: Electronics, Clothing, Books, Food, "
                                "Furniture, Sports, Toys, Beauty, Other"
                            )
                        },
                        "min_price": {
                            "type": "number",
                            "description": "Minimum price filter in USD"
                        },
                        "max_price": {
                            "type": "number",
                            "description": "Maximum price filter in USD"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of results to return (1-20, default 10)"
                        }
                    },
                    "required": []
                }
            }
        }
    },
    {
        "toolSpec": {
            "name": "get_product_details",
            "description": (
                "Retrieve full details for a specific product by its ID. "
                "Use this to get complete information about a product, especially before "
                "adding it to the cart to verify stock and availability. "
                "Also use this when the user asks about a specific product."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "product_id": {
                            "type": "string",
                            "description": "The productId UUID of the product"
                        }
                    },
                    "required": ["product_id"]
                }
            }
        }
    },
    {
        "toolSpec": {
            "name": "get_my_orders",
            "description": (
                "Retrieve the current user's order history. "
                "Use this when the user asks about their past orders, recent purchases, "
                "order status, or what they ordered previously. "
                "Can optionally filter by order status."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "status_filter": {
                            "type": "string",
                            "description": (
                                "Filter orders by status. "
                                "Valid values: pending, confirmed, shipped, delivered, cancelled"
                            )
                        }
                    },
                    "required": []
                }
            }
        }
    },
    {
        "toolSpec": {
            "name": "get_order_details",
            "description": (
                "Retrieve complete details for a specific order by its ID. "
                "Use this when the user asks for details on a specific order "
                "after you have retrieved it from get_my_orders."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "order_id": {
                            "type": "string",
                            "description": "The full order_id UUID"
                        }
                    },
                    "required": ["order_id"]
                }
            }
        }
    },
    {
        "toolSpec": {
            "name": "get_user_profile",
            "description": (
                "Retrieve the current user's profile including name, email, role, gender, and age. "
                "Use this when the user asks about their account, or when personalizing "
                "product recommendations based on demographics."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        }
    },
    {
        "toolSpec": {
            "name": "add_to_cart",
            "description": (
                "Add a product to the user's shopping cart. "
                "Always call get_product_details first to verify the product exists and is in stock "
                "before calling this tool. "
                "Returns a cart_action that the frontend applies to the cart automatically."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "product_id": {
                            "type": "string",
                            "description": "The productId UUID of the product to add"
                        },
                        "quantity": {
                            "type": "integer",
                            "description": "Quantity to add (must be 1 or more)"
                        }
                    },
                    "required": ["product_id", "quantity"]
                }
            }
        }
    },
    {
        "toolSpec": {
            "name": "remove_from_cart",
            "description": (
                "Remove a specific product from the user's shopping cart. "
                "Use the product_id from the current cart contents shown in the conversation context. "
                "Returns a cart_action that the frontend applies automatically."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "product_id": {
                            "type": "string",
                            "description": "The productId of the item to remove from the cart"
                        }
                    },
                    "required": ["product_id"]
                }
            }
        }
    },
    {
        "toolSpec": {
            "name": "clear_cart",
            "description": (
                "Remove all items from the user's shopping cart. "
                "Only use this when the user explicitly asks to clear or empty their entire cart."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        }
    },
    {
        "toolSpec": {
            "name": "place_order",
            "description": (
                "Place an order for all items currently in the user's cart. "
                "Requires a shipping address from the user. "
                "Always confirm the cart contents and total with the user before calling this tool. "
                "On success, the cart is automatically cleared."
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "shipping_address": {
                            "type": "string",
                            "description": "Full shipping address provided by the user (at least 5 characters)"
                        }
                    },
                    "required": ["shipping_address"]
                }
            }
        }
    }
]
