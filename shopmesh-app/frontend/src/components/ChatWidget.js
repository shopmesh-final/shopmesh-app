import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { assistantAPI } from '../services/api';

const WELCOME_PROMPTS = [
  'Show me electronics under $100',
  'What are my recent orders?',
  'Recommend products for me',
  'What gaming products do you have?',
];

const TypingIndicator = () => (
  <div className="chat-msg assistant">
    <div className="chat-typing">
      <div className="chat-typing-dot" />
      <div className="chat-typing-dot" />
      <div className="chat-typing-dot" />
    </div>
  </div>
);

const formatTime = (isoString) => {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

const ChatWidget = () => {
  const { isAuthenticated, user } = useAuth();
  const { items, addToCart, removeFromCart, clearCart } = useCart();

  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasNewMessage, setHasNewMessage] = useState(false);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, isOpen]);

  // Focus textarea when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => textareaRef.current?.focus(), 50);
      setHasNewMessage(false);
    }
  }, [isOpen]);

  const executeCartActions = useCallback((cartActions) => {
    if (!Array.isArray(cartActions)) return;
    cartActions.forEach((action) => {
      switch (action.type) {
        case 'ADD_TO_CART':
          if (action.product) addToCart(action.product);
          break;
        case 'REMOVE_FROM_CART':
          if (action.product_id) removeFromCart(action.product_id);
          break;
        case 'CLEAR_CART':
          clearCart();
          break;
        case 'ORDER_PLACED':
          clearCart();
          break;
        default:
          break;
      }
    });
  }, [addToCart, removeFromCart, clearCart]);

  const sendMessage = useCallback(async (text) => {
    const messageText = (text || inputValue).trim();
    if (!messageText || isLoading) return;

    setInputValue('');
    setError('');

    const userMsg = {
      role: 'user',
      content: messageText,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    // Send last 20 messages as conversation history (excluding the one we just added)
    const history = messages
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    // Build cart_items from CartContext
    const cartItems = items.map((i) => ({
      product_id: i._id || i.productId,
      name: i.name,
      price: i.price,
      quantity: i.quantity,
    }));

    try {
      const response = await assistantAPI.chat({
        message: messageText,
        conversation_history: history,
        cart_items: cartItems,
      });

      const { message, cart_actions, timestamp } = response.data;

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: message, timestamp },
      ]);

      if (cart_actions && cart_actions.length > 0) {
        executeCartActions(cart_actions);
      }

      // Show badge if panel is closed
      if (!isOpen) {
        setHasNewMessage(true);
      }
    } catch (err) {
      const detail =
        err.response?.data?.detail ||
        'Failed to reach the assistant. Please try again.';
      setError(typeof detail === 'string' ? detail : JSON.stringify(detail));
      // Remove the optimistically added user message on failure
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  }, [inputValue, isLoading, messages, items, isOpen, executeCartActions]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!isAuthenticated) return null;

  return (
    <>
      {/* Floating action button */}
      <button
        className="chat-fab"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={isOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
        title="ShopMesh AI Assistant"
      >
        {isOpen ? '✕' : '✦'}
        {hasNewMessage && !isOpen && <span className="chat-fab-badge" />}
      </button>

      {/* Chat panel */}
      {isOpen && (
        <div className="chat-panel" role="dialog" aria-label="ShopMesh AI Assistant">

          {/* Header */}
          <div className="chat-header">
            <div className="chat-header-title">
              <span className="chat-header-dot" />
              ShopMesh Assistant
            </div>
            <button
              className="chat-close-btn"
              onClick={() => setIsOpen(false)}
              aria-label="Close assistant"
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div className="chat-messages">

            {/* Welcome card shown when no messages yet */}
            {messages.length === 0 && (
              <div className="chat-welcome">
                <strong>Hi{user?.name ? `, ${user.name.split(' ')[0]}` : ''}!</strong> I'm your ShopMesh AI assistant.
                I can search products, manage your cart, track orders, and recommend items for you.
                <div className="chat-welcome-prompts">
                  {WELCOME_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      className="chat-prompt-chip"
                      onClick={() => sendMessage(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Conversation messages */}
            {messages.map((msg, idx) => (
              <div key={idx} className={`chat-msg ${msg.role}`}>
                <div className="chat-bubble">{msg.content}</div>
                {msg.timestamp && (
                  <div className="chat-timestamp">{formatTime(msg.timestamp)}</div>
                )}
              </div>
            ))}

            {/* Typing indicator */}
            {isLoading && <TypingIndicator />}

            <div ref={messagesEndRef} />
          </div>

          {/* Error banner */}
          {error && (
            <div className="chat-error">
              {error}
              <button
                className="chat-error-dismiss"
                onClick={() => setError('')}
                aria-label="Dismiss error"
              >
                ✕
              </button>
            </div>
          )}

          {/* Input area */}
          <div className="chat-input-area">
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              placeholder="Ask me anything about products, your cart, orders..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isLoading}
              aria-label="Message input"
            />
            <button
              className="chat-send-btn"
              onClick={() => sendMessage()}
              disabled={isLoading || !inputValue.trim()}
              aria-label="Send message"
              title="Send (Enter)"
            >
              {isLoading ? (
                <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
              ) : (
                '↑'
              )}
            </button>
          </div>

        </div>
      )}
    </>
  );
};

export default ChatWidget;
