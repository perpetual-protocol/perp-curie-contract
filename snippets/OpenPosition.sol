contract OpenPosition {
    // compatible with v1 interface, this does not consider maker.
    // TODO: can we have better interface
    function openPosition(
        baseAddr, // pool
        isBaseToQuote, // side
        margin,
        leverage,
        baseLimit
    ) {
        _settleFunding();

        uint256 base = uni.getExactBaseFromQuote(margin * leverage);
        uint256 sqrtPriceLimit = getSqrtPriceLimit(isBaseToQuote, baseLimit);
        if (isIncreasePos) {
            deposit(margin);
            if (isBaseToQuote) {
                // increase short
                mint(baseToken, base);
                swap(baseToken, quoteToken, baseToQuoteTrue, exactInputTrue, base, sqrtPriceLimit);
            } else {
                // increase long
                mint(quoteToken, margin * leverage);
                swap(baseToken, quoteToken, baseToQuoteFalse, exactInputTrue, margin * leverage, sqrtPriceLimit);
            }
        } else {
            // openReversePosition
            if (isReducePosition()) {
                swap(baseToken, quoteToken, baseToQuoteTrue, exactInputTrue, base, sqrtPriceLimit);
                burn(baseToken, getBaseAvailable(msgSender()));
                burn(quoteToken, getQuoteAvailable(msgSender()));
                _settle(msgSender());
            } else {
                // close and open revers position
                _closePosition(pool, msgSender(), sqrtPriceLimit);
                increasePosition(); // check the logic above
            }
        }

        if (!isPositionClosed()) {
            checkInitMarginRequirement();
        }
    }

    function closePosition(baseToken, slippageProtection) {
        checkMarginRequirement();
        _closePosition(getPool(baseToken), msgSender(), getSqrtPriceLimit(slippageProtection));
        _settle(msgSender());
    }

    function _closePosition(
        pool,
        positionOwner,
        sqrtPriceLimit
    ) {
        Position oldPosition = getPosition(positionOwner);
        int256 basePnl = getBaseAvailable(positionOwner) - getBaseDebt(positionOwner);
        // if has loss
        if (basePnl < 0) {
            // if not enough money to pay back debt
            uint256 quoteLoss = uni.getExactQuoteFromBase(basePnl);

            // TODO: add _mint(): mint quote even the collateral is not enough
            _mint(quote, quoteLoss, forceIsTrue);

            // buy base
            swap(baseToken, quoteToken, baseToQuoteFalse, exactInputFalse, quoteLoss, sqrtPriceLimit);
        } else if (basePnl > 0) {
            // sell extra base
            swap(baseToken, quoteToken, baseToQuoteTrue, exactInputTrue, base, sqrtPriceLimit);
        }
        burn(baseToken, baseDebt);
        // expect baseDebt is cleared
    }

    // settle pnl to trader's collateral
    function _settle(positionOwner) {
        Position oldPosition = getPosition(positionOwner);
        int256 quotePnl = getQuote(positionOwner) - getQuoteDebt(positionOwner);
        if (quotePnl < 0) {
            if (getFreeCollateral(positionOwner) < quotePnl) {
                // start to liquidate other market because the collateral is not enough
                // TODO: how two decide slippage protection when closing all other markets
                for (uint256 i = pools.length; i > 0; i--) {
                    _closePosition(pool, positionOwner, noSlippageProtection);
                    // TODO: improve algo for gas
                    if (getFreeCollateral(positionOwner) >= quotePnl) {
                        break;
                    }
                }
            }
            burn(quoteToken, quoteDebt, oldPosition[quoteToken].available);
            if (quotePnlAfter < 0) {
                _increaseBadDebt(quotePnlAfter);
            }
        } else {
            account[positionOwner].collateral += quotePnl;
        }
        _clearQuoteBalanceAndDebt();
    }
}
