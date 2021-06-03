pragma solidity 0.7.6;
pragma abicoder v2;

/**
 * @dev based on https://www.notion.so/perp/funding-payment-detoo-770e73e47ce640a09b2eeb71e8a7ec46
 */
contract ClearingHouse {

    uint256 public fundingPeriod = 1 hours;
    uint256 public fundingTwapInterval = 1 hours;
    uint256 public nextFundingTime;

    /**
     * @notice "pay funding" by registering the primitives for funding calculations (premiumFraction, markPrice, etc)
     * so that we can defer the actual settlement of payment later for each market and each trader, respectively,
     * therefore spread out the computational loads. It is expected to be called by a keeper every fundingPeriod.
     * @dev TODO WIP, need audit
     * @param _market market address
     * @param _trader trader address
     */
    // TODO review type & name: _market
    function payFunding(Market _market) external {
        // TODO should check if market is open

        uint256 now = _blockTimestamp();
        // TODO audit: this is the same logic as in Perp v1
        require(now >= nextFundingTime, "settle funding too early");

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        uint160 sqrtMarkPrice = getSqrtMarkTwapPrice(_market, twapInterval);
        Decimal.decimal memory indexPrice = getIndexTwapPrice(_market, twapInterval);
        SignedDecimal.signedDecimal memory premium = signedDecimal(uint256(sqrtMarkPrice) * uint256(sqrtMarkPrice)).subD(indexPrice);
        SignedDecimal.signedDecimal memory premiumFraction = premium.mulScalar(fundingPeriod).divScalar(int256(1 days));

        // register primitives for funding calculations so we can settle it later
        _market.premiumFractions.push(premiumFraction);
        _market.sqrtMarkPrices.push(sqrtMarkPrice);

        // TODO audit: this is the same logic as in Perp v1
        // update next funding time requirements so we can prevent multiple funding settlement during very short time after network congestion
        uint256 minNextValidFundingTime = now.add(fundingBufferPeriod);
        // floor((nextFundingTime + fundingPeriod) / 3600) * 3600
        uint256 nextFundingTimeOnHourStart = nextFundingTime.add(fundingPeriod).div(1 hours).mul(1 hours);
        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        nextFundingTime = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;
    }

    /**
     * @notice settle the trader's pending funding payment in a particular market since last settlement
     * @dev TODO WIP, need audit
     * @param _market market address
     * @param _trader trader address
     */
    // TODO review type & name: _market
    function settleFunding(address _market, address _trader) public {

        Position memory position = getPosition(_market, _trader);
        SignedDecimal.signedDecimal memory pendingFundingPayment = getPendingFundingPayment(_market, _trader);

        position.lastFundingSettlementIndex = _market.premiumFractions.length;
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

        // TODO note there is currently no protection on the size of the outer loop. Must analyze the worst case
        //  and see if protection is needed.
        for (uint256 i = position.lastFundingSettlementIndex; i < _market.premiumFractions.length; i++) {
            uint160 sqrtMarkPrice = _market.sqrtMarkPrices[i];
            Decimal.decimal memory vBaseAmount = balanceOf(_market.base, _trader); // amount of vBase the trader owns in CH
            for (uint256 j = 0; j < position.ranges.length; j++) { // amount of vBase the trader owns in pool
                Range range = position.ranges[j];
                // TODO review needed
                if (sqrtMarkPrice <= range.upper) {
                    vBaseAmount = vBaseAmount.addD(
                        (sqrtMarkPrice >= range.lower)
                            ? _market.pool.getAmount0ForLiquidity(range.lower, sqrtMarkPrice, range.liquidity)
                            : _market.pool.getAmount0ForLiquidity(range.lower, range.upper, range.liquidity)
                    );
                }
            }

            // TODO must include fee

            SignedDecimal.signedDecimal memory positionSize = MixedDecimal.fromDecimal(vBaseAmount).subD(position.vBaseDebt);

            pendingFundingPayment.addD(premiumFraction.mulD(positionSize));
        }
    }

    function getSqrtMarkTwapPrice(Market _market, uint256 twapInterval) public view returns (uint160)  {
        uint256 now = _blockTimestamp();
        uint32[] memory secondsAgos = new uint32[](2);

        secondsAgos[0] = uint32(now - fundingTwapInterval);
        secondsAgos[1] = uint32(fundingTwapInterval);
        (int56[] memory tickCumulatives, ) = _market.pool.observe(secondsAgos);

        return TickMath.getSqrtRatioAtTick(
            // TODO should we check of negative value?
            (tickCumulatives[1] - tickCumulatives[0]) / fundingTwapInterval
        );
    }

    /**
     * @notice get underlying twap price provided by oracle
     * @return underlying price
     */
    function getUnderlyingTwapPrice(address _market, uint256 _intervalInSeconds) public view returns (Decimal.decimal memory) {
        // TODO WIP: same as Perp v1
    }
}
