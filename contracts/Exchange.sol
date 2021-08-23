// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Tick } from "./lib/Tick.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { FixedPoint128 } from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";

// TODO move FundingGrowth to another file or library
import { ClearingHouse } from "./ClearingHouse.sol";

contract Exchange is IUniswapV3MintCallback, Ownable {
    using SafeMath for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using PerpSafeCast for int256;
    using Tick for mapping(int24 => Tick.GrowthInfo);

    struct AddLiquidityToOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthGlobalClearingHouseX128;
        uint256 feeGrowthInsideQuoteX128;
        uint256 liquidity;
        ClearingHouse.FundingGrowth globalFundingGrowth;
    }

    /// @param feeGrowthInsideClearingHouseLastX128 there is only quote fee in ClearingHouse
    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideClearingHouseLastX128;
        int256 lastTwPremiumGrowthInsideX96;
        int256 lastTwPremiumGrowthBelowX96;
        int256 lastTwPremiumDivBySqrtPriceGrowthInsideX96;
    }

    address public clearingHouse;
    uint8 public maxOrdersPerMarket;

    // key: accountMarketId => openOrderIds
    mapping(bytes32 => bytes32[]) private _openOrderIdsMap;

    // key: openOrderId
    mapping(bytes32 => OpenOrder) private _openOrderMap;

    // first key: base token, second key: tick index
    // value: the accumulator of **Tick.GrowthInfo** outside each tick of each pool
    mapping(address => mapping(int24 => Tick.GrowthInfo)) private _growthOutsideTickMap;

    // value: the global accumulator of **quote fee transformed from base fee** of each pool
    // key: base token, value: pool
    mapping(address => uint256) private _feeGrowthGlobalX128Map;

    //
    // MODIFIERS
    //
    modifier onlyClearingHouse() {
        // only ClearingHouse
        require(_msgSender() == clearingHouse, "E_OCH");
        _;
    }

    constructor(address clearingHouseArg, uint8 maxOrdersPerMarketArg) {
        clearingHouse = clearingHouseArg;
        maxOrdersPerMarket = maxOrdersPerMarketArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external onlyOwner {
        maxOrdersPerMarket = maxOrdersPerMarketArg;
    }

    // TODO can remove pool once we move addPool to Exchange
    // TODO can remove quotteToken once we add quoteToken to constructor
    struct AddLiquidityParams {
        address trader;
        address baseToken;
        address quoteToken;
        address pool;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        uint256 minBase;
        uint256 minQuote;
        ClearingHouse.FundingGrowth updatedGlobalFundingGrowth;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        uint128 liquidity;
    }

    function addLiquidity(AddLiquidityParams calldata params)
        external
        onlyClearingHouse
        returns (AddLiquidityResponse memory)
    {
        uint256 feeGrowthGlobalClearingHouseX128 = _feeGrowthGlobalX128Map[params.baseToken];
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        UniswapV3Broker.AddLiquidityResponse memory response;

        {
            bool initializedBeforeLower = UniswapV3Broker.getIsTickInitialized(params.pool, params.lowerTick);
            bool initializedBeforeUpper = UniswapV3Broker.getIsTickInitialized(params.pool, params.upperTick);

            // add liquidity to liquidity pool
            response = UniswapV3Broker.addLiquidity(
                UniswapV3Broker.AddLiquidityParams(
                    params.pool,
                    params.baseToken,
                    params.quoteToken,
                    params.lowerTick,
                    params.upperTick,
                    params.base,
                    params.quote
                )
            );
            // mint callback

            int24 currentTick = UniswapV3Broker.getTick(params.pool);
            // initialize tick info
            if (!initializedBeforeLower && UniswapV3Broker.getIsTickInitialized(params.pool, params.lowerTick)) {
                tickMap.initialize(
                    params.lowerTick,
                    currentTick,
                    Tick.GrowthInfo(
                        feeGrowthGlobalClearingHouseX128,
                        params.updatedGlobalFundingGrowth.twPremiumX96,
                        params.updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
                    )
                );
            }
            if (!initializedBeforeUpper && UniswapV3Broker.getIsTickInitialized(params.pool, params.upperTick)) {
                tickMap.initialize(
                    params.upperTick,
                    currentTick,
                    Tick.GrowthInfo(
                        feeGrowthGlobalClearingHouseX128,
                        params.updatedGlobalFundingGrowth.twPremiumX96,
                        params.updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
                    )
                );
            }
        }

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");

        // mutate states
        uint256 fee =
            _addLiquidityToOrder(
                AddLiquidityToOrderParams({
                    maker: params.trader,
                    baseToken: params.baseToken,
                    pool: params.pool,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    feeGrowthGlobalClearingHouseX128: feeGrowthGlobalClearingHouseX128,
                    feeGrowthInsideQuoteX128: response.feeGrowthInsideQuoteX128,
                    liquidity: response.liquidity.toUint256(),
                    globalFundingGrowth: params.updatedGlobalFundingGrowth
                })
            );

        return
            AddLiquidityResponse({
                base: response.base,
                quote: response.quote,
                fee: fee,
                liquidity: response.liquidity
            });
    }

    function _addLiquidityToOrder(AddLiquidityToOrderParams memory params) private returns (uint256 fee) {
        // load existing open order
        bytes32 orderId = _getOrderId(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _openOrderMap[orderId];

        uint256 feeGrowthInsideClearingHouseX128;
        mapping(int24 => Tick.GrowthInfo) storage tickMap = _growthOutsideTickMap[params.baseToken];
        if (openOrder.liquidity == 0) {
            // it's a new order
            bytes32[] storage orderIds = _openOrderIdsMap[_getAccountMarketId(params.maker, params.baseToken)];
            // CH_ONE: orders number exceeded
            require(maxOrdersPerMarket == 0 || orderIds.length < maxOrdersPerMarket, "CH_ONE");
            orderIds.push(orderId);

            openOrder.lowerTick = params.lowerTick;
            openOrder.upperTick = params.upperTick;

            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                tickMap.getAllFundingGrowth(
                    openOrder.lowerTick,
                    openOrder.upperTick,
                    UniswapV3Broker.getTick(params.pool),
                    params.globalFundingGrowth.twPremiumX96,
                    params.globalFundingGrowth.twPremiumDivBySqrtPriceX96
                );
            openOrder.lastTwPremiumGrowthInsideX96 = fundingGrowthRangeInfo.twPremiumGrowthInsideX96;
            openOrder.lastTwPremiumGrowthBelowX96 = fundingGrowthRangeInfo.twPremiumGrowthBelowX96;
            openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96 = fundingGrowthRangeInfo
                .twPremiumDivBySqrtPriceGrowthInsideX96;
        } else {
            feeGrowthInsideClearingHouseX128 = tickMap.getFeeGrowthInside(
                params.lowerTick,
                params.upperTick,
                UniswapV3Broker.getTick(params.pool),
                params.feeGrowthGlobalClearingHouseX128
            );
            fee = _calcOwedFee(
                openOrder.liquidity,
                feeGrowthInsideClearingHouseX128,
                openOrder.feeGrowthInsideClearingHouseLastX128
            );
        }

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().add(params.liquidity).toUint128();
        openOrder.feeGrowthInsideClearingHouseLastX128 = feeGrowthInsideClearingHouseX128;
    }

    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory) {
        return _openOrderIdsMap[_getAccountMarketId(trader, baseToken)];
    }

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder memory) {
        return _openOrderMap[_getOrderId(trader, baseToken, lowerTick, upperTick)];
    }

    // FIXME add _poolMap and check msgSender is uniswapV3
    // or just deal with the vToken in Exchange
    // @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        IUniswapV3MintCallback(clearingHouse).uniswapV3MintCallback(amount0Owed, amount1Owed, data);
    }

    function _getOrderId(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(address(trader), address(baseToken), lowerTick, upperTick));
    }

    function _calcOwedFee(
        uint128 liquidity,
        uint256 feeGrowthInsideNew,
        uint256 feeGrowthInsideOld
    ) private pure returns (uint256) {
        // can NOT use safeMath, feeGrowthInside could be a very large value(a negative value)
        // which causes underflow but what we want is the difference only
        return FullMath.mulDiv(feeGrowthInsideNew - feeGrowthInsideOld, liquidity, FixedPoint128.Q128);
    }

    function _getAccountMarketId(address account, address baseToken) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(account, baseToken));
    }
}
