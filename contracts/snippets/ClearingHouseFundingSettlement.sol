pragma solidity 0.7.6;
pragma abicoder v2;

/**
 * @dev based on https://www.notion.so/perp/funding-payment-detoo-770e73e47ce640a09b2eeb71e8a7ec46
 */
contract ClearingHouse {

    /**
     * @notice settle the trader's pending funding payment in a particular market since last settlement
     * @dev TODO WIP, need audit
     * @param _market market address
     * @param _trader trader address
     */
    // TODO review type & name: _market
    function settleFunding(address _market, address _trader) public {

        Position memory position = getPosition(_amm, _trader);
        SignedDecimal.signedDecimal memory pendingFundingPayment = getPendingFundingPayment(_market, _trader);

        position.lastFundingSettlementTimestamp = _blockTimestamp();
        position.collateral = position.collateral.subD(pendingFundingPayment);

        setPosition(_amm, _trader, position);
    }

    /**
     * @notice calculate the trader's pending funding payment in a particular market since last settlement
     * @dev TODO WIP, need audit
     * @param _market market address
     * @param _trader trader address
     */
    // TODO review type & name: _market
    function getPendingFundingPayment(
        address _market,
        address _trader
    ) public view returns (SignedDecimal.signedDecimal memory pendingFundingPayment) {

        Position memory position = getPosition(_amm, _trader);
        uint256 now = _blockTimestamp();

        // TODO optimization needed: should be dynamic to accommodate long settlement durations.
        uint256 memory fundingSamplingPeriod = 1 hours;

        for (uint256 t = position.lastFundingSettlementTimestamp; t < now; t += fundingSamplingPeriod) {
            uint256 twapInterval = (t + fundingSamplingPeriod > now)? now - t : fundingSamplingPeriod;

            Decimal.decimal memory markPrice = ;// TODO get uniswap v3 twap in time slot t

            Decimal.decimal memory vBaseAmount;
            for (uint256 i = 0; i < position.ranges.length; i++) {
                Range range = position.ranges[i];
                // TODO review needed
                if (markPrice <= range.upper) {
                    vBaseAmount = vBaseAmount.addD(
                        (markPrice >= range.lower)
                            ? range.pool.getAmount0ForLiquidity(range.lower, markPrice, range.liquidity)
                            : range.pool.getAmount0ForLiquidity(range.lower, range.upper, range.liquidity)
                    );
                }
            }
            SignedDecimal.signedDecimal memory positionSize = MixedDecimal.fromDecimal(vBaseAmount).subD(position.vBaseDebt);

            Decimal.decimal memory indexPrice = getIndexTwapPrice(twapInterval);
            SignedDecimal.signedDecimal memory premium = MixedDecimal.fromDecimal(markPrice).subD(indexPrice);
            SignedDecimal.signedDecimal memory premiumFraction = premium.mulScalar(twapInterval).divScalar(int256(1 days));

            pendingFundingPayment.addD(premiumFraction.mulD(positionSize));
        }
    }
}
