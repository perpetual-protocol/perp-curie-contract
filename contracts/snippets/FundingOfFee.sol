pragma solidity 0.7.6;

contract CH {
    struct RangeOrder {
        // ... other vars
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        // the index of fundingHistoryArr
        uint256 lastFundingIndex;
        uint256 feeGrowthInsideLastBaseX128;
        uint256 feeGrowthInsideLastQuoteX128;
        uint128 owedBase;
        uint128 owedQuote;
    }

    // the record at the time of updating funding
    struct FundingHistory {
        int24 tick;
        uint256 blockNumber;
        uint256 feeGrowthGlobalBaseX128;
        // quote is required as well for the Tick.getFeeGrowthInside() function
        uint256 feeGrowthGlobalQuoteX128;
    }

    // Maker's ranges
    mapping(bytes32 => RangeOrder) rangeMap;
    FundingHistory[] public fundingHistoryArr;

    function getPendingFundingPayment(IUniswapV3Pool _pool)
        internal
        returns (
            uint256 base,
            // we'll update owedQuote at the same time thus return it as well
            uint256 quote
        )
    {
        // get trader's rangeOrder
        // RangeOrder memory rangeOrder = rangeOrderMap(...)
        RangeOrder memory rangeOrder;
        uint256 lastFundingIndex = rangeOrder.lastFundingIndex;

        // rangeOrder.lastFundingIndex is an index, so +1
        if (fundingHistoryArr.length != lastFundingIndex + 1) {
            FundingHistory memory fundingHistory;

            uint256 loopLength =
                fundingHistoryArr.length - lastFundingIndex - 1;

            uint256 owedBase = rangeOrder.owedBase;
            uint256 owedQuote = rangeOrder.owedQuote;

            // update these local values each time instead of the global one
            uint256 feeGrowthInsideLastBaseX128 =
                rangeOrder.feeGrowthInsideLastBaseX128;
            uint256 feeGrowthInsideLastQuoteX128 =
                rangeOrder.feeGrowthInsideLastQuoteX128;

            // need a better naming as there are two same values of feeGrowthInsideLastBaseX128 here
            uint256 __feeGrowthInsideLastBaseX128;
            uint256 __feeGrowthInsideLastQuoteX128;

            uint256 feeGrowthInside0X128;
            uint256 feeGrowthInside1X128;

            for (uint256 i = 0; i < loopLength; i++) {
                // get base & quote amount from Detoo's pr
                // base = ...
                // quote = ...

                fundingHistory = fundingHistoryArr[lastFundingIndex + i];

                (feeGrowthInside0X128, feeGrowthInside1X128) = _pool
                    .ticks
                    .getFeeGrowthInside(
                    rangeOrder.lowerTick,
                    rangeOrder.upperTick,
                    fundingHistory.tick,
                    fundingHistory.feeGrowthGlobalBaseX128,
                    fundingHistory.feeGrowthGlobalQuoteX128
                );
                // get feeGrowthInsideLastBaseX128 by sorting feeGrowthInside0X128 & feeGrowthInside1X128
                // __feeGrowthInsideLastBaseX128 = ...
                // __feeGrowthInsideLastQuoteX128 = ...

                // copied from Position.sol
                // should be able to extract this as an internal function for others usages such as in collect()
                owedBase = owedBase.add(
                    uint128(
                        FullMath.mulDiv(
                            __feeGrowthInsideLastBaseX128 -
                                feeGrowthInsideLastBaseX128,
                            rangeOrder.liquidity,
                            FixedPoint128.Q128
                        )
                    )
                );

                owedQuote = owedQuote.add(
                    uint128(
                        FullMath.mulDiv(
                            __feeGrowthInsideLastQuoteX128 -
                                feeGrowthInsideLastQuoteX128,
                            rangeOrder.liquidity,
                            FixedPoint128.Q128
                        )
                    )
                );

                // update values for the next loop
                base = base.add(owedBase);
                quote = quote.add(owedQuote);
                feeGrowthInsideLastBaseX128 = __feeGrowthInsideLastBaseX128;
                feeGrowthInsideLastQuoteX128 = __feeGrowthInsideLastQuoteX128;
            }

            // update values after the end of the loop
            // not sure if assigning by the whole struct will be cheaper or not

            // after this function fundingHistoryArr will be updated
            // while it's index, so it'd be equal to the length after the update
            range.lastFundingIndex = fundingHistoryArr.length;
            range.feeGrowthInsideLastBaseX128 = feeGrowthInsideLastBaseX128;
            range.feeGrowthGlobalQuoteX128 = feeGrowthInsideLastQuoteX128;
            range.owedBase = owedBase;
            range.owedQuote = owedQuote;
        }
    }
}
