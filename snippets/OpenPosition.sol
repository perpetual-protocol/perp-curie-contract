/**
- open position: 
  - even if the caller is an maker, it wont affect her open order
  - there're 4 combination (isBaseToQuote * isExactInput)
  - it settles funding
  - it mints missing amount of vToken for swapping
  - it does not mint anything if it's already sufficient
- close position:
  - net position size will be zero
  - taker has ETH position
    - when loss
        - if the free collateral is not enough to cover the loss, revert (TODO: insurance fund)
        - if the collateral is enough to cover the loss, free collateral will be less
    - when profit
        - free collateral increase
  - taker has ETH and BTC position 
    - when loss
        - if the free collateral is not enough to cover the loss, then BTC will be able to be liquidated
 */

contract OpenPosition {
    function openPosition(
        baseToken, // pool
        isBaseToQuote,
        isExactInput,
        amount,
        sqrtPriceLimitX96
    ) {
        _settleFunding();

        _openPosition(baseToken, isBaseToQuote, isExactInput, amount, sqrtPriceLimitX96);

        if (isPositionClosed()) {
            _settle(msgSender());
        } else {
            requiredInitMarginRequirement();
        }
    }

    function _openPosition(
        baseToken, // pool
        isBaseToQuote,
        isExactInput,
        amount,
        sqrtPriceLimitX96
    ) {
        // TODO if quote available is not enough, should we mint quote if it's under imRatio?
        // calculate if we need to mint more quote or base to buy the exact output
        if (!isExactInput) {
            if (isBaseToQuote) {
                // taker want to get exact quote from base
                // calc how many base is needed for the exact quote
                uint256 requiredBase = uni.getExactBaseFromQuote(amount);
                // make sure taker has enough base to buy the desired quote
                if (getBaseAvailable < requiredBase) {
                    // if it's reducing position to 0 we don't need to check margin
                    _mint(baseToken, insufficientBase, forceIsTrue);
                }
            } else {
                // taker want to get exact base from quote
                // calc how many quote is needed for the exact base
                uint256 requiredQuote = uni.getExactQuoteFromBase(amount);
                // make sure taker has enough quote to buy the desired base
                if (getQuoteAvailable < requiredQuote) {
                    // if it's reducing position to 0 we don't need to check margin
                    _mint(quoteToken, insufficientQuote, forceIsTrue);
                }
            }
        }

        swap(baseToken, quoteToken, isBaseToQuote, isExactInput, amount, sqrtPriceLimitX96);
    }

    function closePosition(baseToken, sqrtPriceLimit) {
        _settleFunding();
        _closePosition(getPool(baseToken), msgSender(), sqrtPriceLimit);
    }

    function liquidate(posOwner, baseToken) {
        checkLiquidationRequirement(posOwner, baseToken);
        _settleFunding();
        _closePosition(getPool(baseToken), posOwner, sqrtPriceLimit);
    }

    function _closePosition(
        pool,
        positionOwner,
        sqrtPriceLimit
    ) {
        int256 basePnl = getBaseAvailable(positionOwner) - getBaseDebt(positionOwner);
        // if has loss
        if (basePnl < 0) {
            // buy exact base loss to pay back debt
            _openPosition(baseToken, quoteToken, baseToQuoteFalse, exactInputFalse, basePnl, sqrtPriceLimit);
        } else if (basePnl > 0) {
            // sell extra base
            _openPosition(baseToken, quoteToken, baseToQuoteTrue, exactInputTrue, base, sqrtPriceLimit);
        }
        burn(baseToken, baseDebt);
        // expect baseAvailable and baseDebt are cleared

        _settle(posOwner);
    }

    function mint(token, amount) {
        _mint(token, amount, ForceIsFalse);
    }

    function _mint(
        token,
        amount,
        isForce
    ) {
        // TODO move mint's code here
        // *** PASTED *** //
        if (!isForce) {
            requiredInitMarginRequirement();
        }
    }

    // settle pnl to trader's collateral when there's no position is hold
    function _settle(positionOwner) {
        if (!_hasZeroPosition()) {
            return;
        }

        uint256 burnableQuote = min(quoteAvailable, quoteDebt);
        burn(quote, burnableQuote);
        if (quoteDebt > 0) {
            // under collateral, insurance fund get hurt
            _increaseBadDebt(quoteDebt);
        } else {
            account[positionOwner].collateral += quoteAvailable;
        }
        _clearQuoteBalanceAndDebt();
    }
}
