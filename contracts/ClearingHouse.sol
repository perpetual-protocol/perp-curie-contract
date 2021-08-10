pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { FixedPoint128 } from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import { SwapMath } from "@uniswap/v3-core/contracts/libraries/SwapMath.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { LiquidityMath } from "@uniswap/v3-core/contracts/libraries/LiquidityMath.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { IMintableERC20 } from "./interface/IMintableERC20.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ISettlement } from "./interface/ISettlement.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { Validation } from "./base/Validation.sol";
import { Tick } from "./lib/Tick.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { IVault } from "./interface/IVault.sol";
import { ArbBlockContext } from "./arbitrum/ArbBlockContext.sol";

contract ClearingHouse is
    IUniswapV3MintCallback,
    IUniswapV3SwapCallback,
    ISettlement,
    ReentrancyGuard,
    Validation,
    Ownable
{
    using SafeMath for uint256;
    using SafeMath for uint160;
    using SafeCast for uint256;
    using SafeCast for uint128;
    using SignedSafeMath for int256;
    using SafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using Tick for mapping(int24 => uint256);
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;

    //
    // events
    //
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);
    event Minted(address indexed trader, address indexed token, uint256 amount);
    event Burned(address indexed trader, address indexed token, uint256 amount);
    event LiquidityChanged(
        address indexed maker,
        address indexed baseToken,
        address indexed quoteToken,
        int24 lowerTick,
        int24 upperTick,
        // amount of base token added to the liquidity (excl. fee) (+: add liquidity, -: remove liquidity)
        int256 base,
        // amount of quote token added to the liquidity (excl. fee) (+: add liquidity, -: remove liquidity)
        int256 quote,
        int128 liquidity, // amount of liquidity unit added (+: add liquidity, -: remove liquidity)
        uint256 quoteFee // amount of quote token the maker received as fee
    );
    event FundingRateUpdated(address indexed baseToken, int256 rate, uint256 underlyingPrice);
    event FundingSettled(
        address indexed trader,
        address indexed baseToken,
        uint256 nextPremiumFractionIndex,
        int256 amount // +: trader pays, -: trader receives
    );
    event Swapped(
        address indexed trader,
        address indexed baseToken,
        int256 exchangedPositionSize,
        int256 exchangedPositionNotional,
        uint256 fee,
        int256 fundingPayment,
        uint256 badDebt
    );

    event LiquidationPenaltyRatioChanged(uint256 liquidationPenaltyRatio);

    event PositionLiquidated(
        address indexed trader,
        address indexed baseToken,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator
    );

    //
    // Struct
    //

    struct Account {
        // realized pnl but haven't settle to collateral, vToken decimals
        int256 owedRealizedPnl;
        address[] tokens; // all tokens (base only) this account is in debt of
        // key: token address, e.g. vETH...
        mapping(address => TokenInfo) tokenInfoMap; // balance & debt info of each token
        // key: base token address, negative when long, positive when short
        mapping(address => int256) openNotionalMap;
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => MakerPosition) makerPositionMap; // open orders for maker
        // key: token address, value: next premium fraction index for settling funding payment
        mapping(address => uint256) nextPremiumFractionIndexMap;
    }

    struct TokenInfo {
        uint256 available; // amount available in CH
        uint256 debt;
    }

    /// @param feeGrowthInsideClearingHouseLastX128 there is only quote fee in ClearingHouse
    /// @param feeGrowthInsideUniswapLastX128 we only care about quote fee
    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideClearingHouseLastX128;
        uint256 feeGrowthInsideUniswapLastX128;
    }

    struct MakerPosition {
        bytes32[] orderIds;
        // key: order id
        mapping(bytes32 => OpenOrder) openOrderMap;
    }

    struct FundingHistory {
        int256 premiumFractions;
        uint160 sqrtMarkPriceX96;
    }

    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    struct AddLiquidityToOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthGlobalClearingHouseX128;
        uint256 feeGrowthInsideQuoteX128;
        uint256 liquidity;
    }

    /// @param liquidity collect fee when 0
    struct RemoveLiquidityParams {
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    struct RemoveLiquidityFromOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideQuoteX128;
        uint256 liquidity;
    }

    struct InternalRemoveLiquidityParams {
        address maker;
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct SwapParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    struct InternalSwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool mint;
    }

    struct SwapResponse {
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        uint256 exchangedPositionSize;
        uint256 exchangedPositionNotional;
    }

    struct SwapStep {
        uint160 initialSqrtPriceX96;
        int24 nextTick;
        bool isNextTickInitialized;
        uint160 nextSqrtPriceX96;
        uint256 amountOut;
    }

    struct SwapState {
        int24 tick;
        uint160 sqrtPriceX96;
        int256 amountSpecifiedRemaining;
        uint256 feeGrowthGlobalX128;
        uint128 liquidity;
    }

    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    struct InternalOpenPositionParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool skipMarginRequirementCheck;
    }

    struct SwapCallbackData {
        address trader;
        address baseToken;
        bool mint;
    }

    // 10 wei
    uint256 private constant _DUST = 10;

    //
    // state variables
    //
    uint256 public imRatio = 0.1 ether; // initial-margin ratio, 10%
    uint256 public mmRatio = 0.0625 ether; // minimum-margin ratio, 6.25%

    address public immutable quoteToken;
    address public immutable uniswapV3Factory;
    address public vault;
    uint8 private immutable _settlementTokenDecimals;

    // key: base token, value: pool
    mapping(address => address) private _poolMap;

    // key: trader
    mapping(address => Account) private _accountMap;

    // first key: base token, second key: tick index
    // value: the accumulator of **quote fee transformed from base fee** outside each tick of each pool
    mapping(address => mapping(int24 => uint256)) private _feeGrowthOutsideX128TickMap;

    // value: the global accumulator of **quote fee transformed from base fee** of each pool
    // key: base token, value: pool
    mapping(address => uint256) private _feeGrowthGlobalX128Map;

    uint256 public immutable fundingPeriod;
    // key: base token
    mapping(address => uint256) private _nextFundingTimeMap;
    mapping(address => FundingHistory[]) private _fundingHistoryMap;

    uint256 public liquidationPenaltyRatio = 0.025 ether; // initial penalty ratio, 2.5%

    constructor(
        address vaultArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        uint256 fundingPeriodArg
    ) {
        // vault is 0
        require(vaultArg != address(0), "CH_VI0");

        // quoteToken is 0
        require(quoteTokenArg != address(0), "CH_QI0");

        // uniV3Factory is 0
        require(uniV3FactoryArg != address(0), "CH_U10");

        vault = vaultArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
        fundingPeriod = fundingPeriodArg;

        _settlementTokenDecimals = IVault(vault).decimals();
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function addPool(address baseToken, uint24 feeRatio) external onlyOwner {
        // TODO enforce decimals = 18
        // to ensure the base is always token0 and quote is always token1
        // CH_IB: invalid baseToken
        require(baseToken < quoteToken, "CH_IB");
        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // CH_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "CH_NEP");
        // CH_EP: existent pool in ClearingHouse
        require(pool != _poolMap[baseToken], "CH_EP");
        // CH_PNI: pool not (yet) initialized
        require(UniswapV3Broker.getSqrtMarkPriceX96(pool) != 0, "CH_PNI");

        _poolMap[baseToken] = pool;
        emit PoolAdded(baseToken, feeRatio, pool);
    }

    function mint(address token, uint256 amount) external nonReentrant() {
        if (token != quoteToken) {
            _requireHasBaseToken(token);
            _registerBaseToken(_msgSender(), token);
        }
        // always check margin ratio
        _mint(_msgSender(), token, amount, true);
    }

    /**
     * @param amount the amount of debt to burn
     */
    function burn(address token, uint256 amount) public nonReentrant() {
        if (token != quoteToken) {
            _requireHasBaseToken(token);
        }
        _burn(_msgSender(), token, amount);
    }

    function swap(SwapParams memory params) public nonReentrant() returns (SwapResponse memory) {
        _requireHasBaseToken(params.baseToken);
        _registerBaseToken(_msgSender(), params.baseToken);

        return
            _swapAndCalculateOpenNotional(
                InternalSwapParams({
                    trader: _msgSender(),
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    mint: false
                })
            );
    }

    function addLiquidity(AddLiquidityParams calldata params) external nonReentrant() checkDeadline(params.deadline) {
        _requireHasBaseToken(params.baseToken);

        address trader = _msgSender();

        // register token if it's the first time
        _registerBaseToken(trader, params.baseToken);

        _settleFunding(trader, params.baseToken);

        // update internal states
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        // CH_NEB: not enough available base amount
        require(baseTokenInfo.available >= params.base, "CH_NEB");
        // CH_NEB: not enough available quote amount
        require(quoteTokenInfo.available >= params.quote, "CH_NEQ");

        address pool = _poolMap[params.baseToken];
        uint256 feeGrowthGlobalClearingHouseX128 = _feeGrowthGlobalX128Map[params.baseToken];
        mapping(int24 => uint256) storage tickMap = _feeGrowthOutsideX128TickMap[params.baseToken];
        UniswapV3Broker.AddLiquidityResponse memory response;

        {
            bool initializedBeforeLower = UniswapV3Broker.getIsTickInitialized(pool, params.lowerTick);
            bool initializedBeforeUpper = UniswapV3Broker.getIsTickInitialized(pool, params.upperTick);

            // add liquidity to liquidity pool
            response = UniswapV3Broker.addLiquidity(
                UniswapV3Broker.AddLiquidityParams(
                    pool,
                    params.baseToken,
                    quoteToken,
                    params.lowerTick,
                    params.upperTick,
                    params.base,
                    params.quote
                )
            );

            int24 currentTick = UniswapV3Broker.getTick(pool);
            // initialize tick info
            if (!initializedBeforeLower && UniswapV3Broker.getIsTickInitialized(pool, params.lowerTick)) {
                tickMap.initialize(params.lowerTick, currentTick, feeGrowthGlobalClearingHouseX128);
            }
            if (!initializedBeforeUpper && UniswapV3Broker.getIsTickInitialized(pool, params.upperTick)) {
                tickMap.initialize(params.upperTick, currentTick, feeGrowthGlobalClearingHouseX128);
            }
        }

        // mint callback

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");

        // mutate states
        (uint256 quoteFeeClearingHouse, uint256 quoteFeeUniswap) =
            _addLiquidityToOrder(
                AddLiquidityToOrderParams({
                    maker: trader,
                    baseToken: params.baseToken,
                    pool: pool,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    feeGrowthGlobalClearingHouseX128: feeGrowthGlobalClearingHouseX128,
                    feeGrowthInsideQuoteX128: response.feeGrowthInsideQuoteX128,
                    liquidity: response.liquidity.toUint256()
                })
            );

        // update token info
        // TODO should burn base fee received instead of adding it to available amount
        baseTokenInfo.available = baseTokenInfo.available.sub(response.base);
        quoteTokenInfo.available = quoteTokenInfo.available.add(quoteFeeClearingHouse).add(quoteFeeUniswap).sub(
            response.quote
        );

        // TODO move it back if we can fix stack too deep
        _emitLiquidityChanged(trader, params, response, quoteFeeClearingHouse.add(quoteFeeUniswap));
    }

    function _addLiquidityToOrder(AddLiquidityToOrderParams memory params)
        private
        returns (uint256 quoteFeeClearingHouse, uint256 quoteFeeUniswap)
    {
        // load existing open order
        bytes32 orderId = _getOrderId(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder =
            _accountMap[params.maker].makerPositionMap[params.baseToken].openOrderMap[orderId];

        uint256 feeGrowthInsideClearingHouseX128;
        if (openOrder.liquidity == 0) {
            // it's a new order
            MakerPosition storage makerPosition = _accountMap[params.maker].makerPositionMap[params.baseToken];
            makerPosition.orderIds.push(orderId);

            openOrder.lowerTick = params.lowerTick;
            openOrder.upperTick = params.upperTick;
        } else {
            mapping(int24 => uint256) storage tickMap = _feeGrowthOutsideX128TickMap[params.baseToken];
            feeGrowthInsideClearingHouseX128 = tickMap.getFeeGrowthInside(
                params.lowerTick,
                params.upperTick,
                UniswapV3Broker.getTick(params.pool),
                params.feeGrowthGlobalClearingHouseX128
            );
            quoteFeeClearingHouse = _calcOwedFee(
                openOrder.liquidity,
                feeGrowthInsideClearingHouseX128,
                openOrder.feeGrowthInsideClearingHouseLastX128
            );
            quoteFeeUniswap = _calcOwedFee(
                openOrder.liquidity,
                params.feeGrowthInsideQuoteX128,
                openOrder.feeGrowthInsideUniswapLastX128
            );
        }

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().add(params.liquidity).toUint128();
        openOrder.feeGrowthInsideClearingHouseLastX128 = feeGrowthInsideClearingHouseX128;
        openOrder.feeGrowthInsideUniswapLastX128 = params.feeGrowthInsideQuoteX128;
    }

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        nonReentrant()
        checkDeadline(params.deadline)
    {
        _requireHasBaseToken(params.baseToken);
        (uint256 base, uint256 quote) =
            _removeLiquidity(
                InternalRemoveLiquidityParams({
                    maker: _msgSender(),
                    baseToken: params.baseToken,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );

        // price slippage check
        require(base >= params.minBase && quote >= params.minQuote, "CH_PSC");
    }

    function openPosition(OpenPositionParams memory params) external {
        _requireHasBaseToken(params.baseToken);
        _registerBaseToken(_msgSender(), params.baseToken);

        _openPosition(
            InternalOpenPositionParams({
                trader: _msgSender(),
                baseToken: params.baseToken,
                isBaseToQuote: params.isBaseToQuote,
                isExactInput: params.isExactInput,
                amount: params.amount,
                sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                skipMarginRequirementCheck: false
            })
        );
    }

    // @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data // contains baseToken
    ) external override {
        address baseToken = abi.decode(data, (address));
        address pool = _poolMap[baseToken];
        // CH_FMV: failed mintCallback verification
        require(_msgSender() == pool, "CH_FMV");

        if (amount0Owed > 0) {
            TransferHelper.safeTransfer(IUniswapV3Pool(pool).token0(), pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            TransferHelper.safeTransfer(IUniswapV3Pool(pool).token1(), pool, amount1Owed);
        }
    }

    function setLiquidationPenaltyRatio(uint256 liquidationPenaltyRatioArg) external onlyOwner {
        liquidationPenaltyRatio = liquidationPenaltyRatioArg;
        emit LiquidationPenaltyRatioChanged(liquidationPenaltyRatioArg);
    }

    function liquidate(address trader, address baseToken) external nonReentrant() {
        _requireHasBaseToken(baseToken);
        // CH_EAV: enough account value
        require(
            getAccountValue(trader).lt(_getTotalMinimumMarginRequirement(trader).toInt256(), _settlementTokenDecimals),
            "CH_EAV"
        );

        _removeAllLiquidity(trader, baseToken);

        // since all liquidity has been removed, there's no position in pool now
        TokenInfo memory tokenInfo = getTokenInfo(trader, baseToken);
        int256 positionSize = tokenInfo.available.toInt256().sub(tokenInfo.debt.toInt256());

        // if trader is on long side, baseToQuote: true, exactInput: true
        // if trader is on short side, baseToQuote: false (quoteToBase), exactInput: false (exactOutput)
        bool isLong = positionSize > 0 ? true : false;
        SwapResponse memory response =
            _openPosition(
                InternalOpenPositionParams({
                    trader: trader,
                    baseToken: baseToken,
                    isBaseToQuote: isLong,
                    isExactInput: isLong,
                    amount: positionSize.abs(),
                    sqrtPriceLimitX96: 0,
                    skipMarginRequirementCheck: true
                })
            );

        // trader's pnl-- as liquidation penalty
        uint256 liquidationFee = response.exchangedPositionNotional.mul(liquidationPenaltyRatio).divideBy10_18();
        _accountMap[trader].owedRealizedPnl = _accountMap[trader].owedRealizedPnl.sub(liquidationFee.toInt256());

        // increase liquidator's pnl liquidation reward
        address liquidator = _msgSender();
        _accountMap[liquidator].owedRealizedPnl = _accountMap[liquidator].owedRealizedPnl.add(
            liquidationFee.toInt256()
        );

        emit PositionLiquidated(
            trader,
            baseToken,
            response.exchangedPositionNotional,
            positionSize.abs(),
            liquidationFee,
            liquidator
        );
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_F0S: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        SwapCallbackData memory callbackData = abi.decode(data, (SwapCallbackData));
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[callbackData.baseToken]);
        // CH_FSV: failed swapCallback verification
        require(_msgSender() == address(pool), "CH_FSV");

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0 ? (pool.token0(), uint256(amount0Delta)) : (pool.token1(), uint256(amount1Delta));

        bool isBaseToQuote = token == callbackData.baseToken;
        uint256 exactSwappedAmount = amountToPay;

        // we know the exact amount of a token is needed for swap in the swap callback
        // we separate into two part
        // 1. extra minted tokens due to quote only fee
        // 2. tokens that a trader needs when openPosition

        // 1. quote only fee
        // if `isBaseToQuote`, the amountToPay is scaled
        // so we need to scale down the amount to get the exact user's input amount
        // the difference of these two values is minted for compensate the base fee
        if (isBaseToQuote) {
            // mint extra base token before swap
            exactSwappedAmount = FeeMath.calcScaledAmount(address(pool), amountToPay, false);
            // not use _mint() here since it will change trader's baseToken available/debt
            IMintableERC20(token).mint(address(this), amountToPay.sub(exactSwappedAmount));
        }

        // 2. openPosition
        if (callbackData.mint) {
            uint256 availableBefore = getTokenInfo(callbackData.trader, token).available;
            if (availableBefore < exactSwappedAmount) {
                _mint(callbackData.trader, token, exactSwappedAmount.sub(availableBefore), true);
            }
        }

        // swap
        TransferHelper.safeTransfer(token, _msgSender(), amountToPay);
    }

    /**
     * @notice "pay funding" by registering the primitives for funding calculations (premiumFraction, markPrice, etc)
     * so that we can defer the actual settlement of payment later for each market and each trader, respectively,
     * therefore spread out the computational loads. It is expected to be called by a keeper every fundingPeriod.
     * @param baseToken base token address
     */
    function updateFunding(address baseToken) external {
        _requireHasBaseToken(baseToken);

        // solhint-disable-next-line not-rely-on-time
        uint256 nowTimestamp = _blockTimestamp();
        // CH_UFTE update funding too early
        require(nowTimestamp >= _nextFundingTimeMap[baseToken], "CH_UFTE");

        // premium = markTwap - indexTwap
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[baseToken]);
        int256 premiumFraction;
        {
            uint160 sqrtMarkTwapX96 = UniswapV3Broker.getSqrtMarkTwapX96(_poolMap[baseToken], fundingPeriod);
            uint256 markTwap = sqrtMarkTwapX96.formatX96ToX10_18();
            uint256 indexTwap = _getIndexPrice(baseToken, fundingPeriod);

            int256 premium = markTwap.toInt256().sub(indexTwap.toInt256());
            premiumFraction = premium.mul(fundingPeriod.toInt256()).div(int256(1 days));

            emit FundingRateUpdated(baseToken, premiumFraction.mul(1 ether).div(indexTwap.toInt256()), indexTwap);
        }

        // register primitives for funding calculations so we can settle it later
        (uint160 sqrtMarkPriceX96, , , , , , ) = pool.slot0();
        FundingHistory memory fundingHistory =
            FundingHistory({ premiumFractions: premiumFraction, sqrtMarkPriceX96: sqrtMarkPriceX96 });
        _fundingHistoryMap[baseToken].push(fundingHistory);

        // update next funding time requirements so we can prevent multiple funding settlement
        // during very short time after network congestion
        uint256 minNextValidFundingTime = nowTimestamp.add(fundingPeriod.div(2));
        // (floor(nowTimestamp / fundingPeriod) + 1) * fundingPeriod
        uint256 nextFundingTimeOnHourStart = nowTimestamp.div(fundingPeriod).add(1).mul(fundingPeriod);
        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        _nextFundingTimeMap[baseToken] = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;
    }

    function settleFunding(address trader, address token) external returns (int256 fundingPayment) {
        _requireHasBaseToken(token);
        return _settleFunding(trader, token);
    }

    function cancelExcessOrders(address maker, address baseToken) external nonReentrant() {
        _requireHasBaseToken(baseToken);
        // CH_EAV: enough account value
        // shouldn't cancel open orders
        require(
            getAccountValue(maker).lt(_getTotalInitialMarginRequirement(maker).toInt256(), _settlementTokenDecimals),
            "CH_EAV"
        );

        bytes32[] memory orderIds = _accountMap[maker].makerPositionMap[baseToken].orderIds;
        for (uint256 i = 0; i < orderIds.length; i++) {
            bytes32 orderId = orderIds[i];
            OpenOrder memory openOrder = _accountMap[maker].makerPositionMap[baseToken].openOrderMap[orderId];
            _removeLiquidity(
                InternalRemoveLiquidityParams(
                    maker,
                    baseToken,
                    openOrder.lowerTick,
                    openOrder.upperTick,
                    openOrder.liquidity
                )
            );

            // burn maker's debt to reduce maker's init margin requirement
            _burnMax(maker, baseToken);
        }

        // burn maker's quote to reduce maker's init margin requirement
        _burnMax(maker, quoteToken);
    }

    function settle(address account) external override returns (int256) {
        // only vault
        require(_msgSender() == vault, "CH_OV");

        Account storage accountStorage = _accountMap[account];
        int256 pnl = accountStorage.owedRealizedPnl;
        accountStorage.owedRealizedPnl = 0;

        // TODO should check quote in pool as well
        if (accountStorage.tokens.length > 0) {
            return pnl;
        }

        // settle quote if all position are closed
        TokenInfo storage quoteInfo = _accountMap[account].tokenInfoMap[quoteToken];
        if (quoteInfo.available >= quoteInfo.debt) {
            // profit
            uint256 profit = quoteInfo.available.sub(quoteInfo.debt);
            quoteInfo.available = quoteInfo.available.sub(profit);
            pnl = pnl.add(profit.toInt256());

            // burn profit in quote and add to collateral
            IMintableERC20(quoteToken).burn(profit);
        } else {
            // loss
            uint256 loss = quoteInfo.debt.sub(quoteInfo.available);
            quoteInfo.debt = quoteInfo.debt.sub(loss);
            pnl = pnl.sub(loss.toInt256());
        }
        return pnl;
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getPool(address baseToken) external view returns (address poolAddress) {
        return _poolMap[baseToken];
    }

    // return in settlement token decimals
    function getAccountValue(address account) public view returns (int256) {
        return _getTotalCollateralValue(account).addS(getTotalUnrealizedPnl(account), _settlementTokenDecimals);
    }

    // return in settlement token decimals
    function _getTotalCollateralValue(address account) private view returns (int256) {
        int256 owedRealizedPnl = _accountMap[account].owedRealizedPnl;
        return IVault(vault).balanceOf(account).toInt256().addS(owedRealizedPnl, _settlementTokenDecimals);
    }

    // return in virtual token decimals
    function _getBuyingPower(address account) private view returns (uint256) {
        int256 accountValue = getAccountValue(account);
        int256 totalCollateralValue = _getTotalCollateralValue(account);
        int256 minOfAccountAndCollateralValue =
            accountValue < totalCollateralValue ? accountValue : totalCollateralValue;
        int256 totalInitialMarginRequirement = _getTotalInitialMarginRequirement(account).toInt256();
        int256 buyingPower =
            minOfAccountAndCollateralValue.subS(totalInitialMarginRequirement, _settlementTokenDecimals);
        if (buyingPower < 0) {
            return 0;
        }
        return buyingPower.toUint256().parseSettlementToken(_settlementTokenDecimals).mul(1 ether).div(imRatio);
    }

    // (totalBaseDebtValue + totalQuoteDebtValue) * imRatio
    function getTotalOpenOrderMarginRequirement(address trader) external view returns (uint256) {
        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = _accountMap[trader].tokenInfoMap[quoteToken].debt;
        return _getTotalBaseDebtValue(trader).add(quoteDebtValue).mul(imRatio).divideBy10_18();
    }

    // TODO refactor with _getTotalBaseDebtValue and getTotalUnrealizedPnl
    function _getTotalAbsPositionValue(address trader) private view returns (uint256) {
        Account storage account = _accountMap[trader];
        uint256 totalPositionValue;
        uint256 tokenLen = account.tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = account.tokens[i];
            if (_isPoolExistent(baseToken)) {
                // will not use negative value in this case
                uint256 positionValue = getPositionValue(trader, baseToken, 0).abs();
                totalPositionValue = totalPositionValue.add(positionValue);
            }
        }
        return totalPositionValue;
    }

    function _getTotalBaseDebtValue(address trader) private view returns (uint256) {
        Account storage account = _accountMap[trader];
        uint256 totalBaseDebtValue;
        uint256 tokenLen = account.tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = account.tokens[i];
            if (_isPoolExistent(baseToken)) {
                uint256 baseDebtValue = _getDebtValue(baseToken, account.tokenInfoMap[baseToken].debt);
                totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
            }
        }
        return totalBaseDebtValue;
    }

    // NOTE: the negative value will only be used when calculating pnl
    function getPositionValue(
        address trader,
        address token,
        uint256 twapInterval
    ) public view returns (int256 positionValue) {
        int256 positionSize = _getPositionSize(trader, token, UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[token]));
        if (positionSize == 0) return 0;

        uint256 indexTwap = IIndexPrice(token).getIndexPrice(twapInterval);

        // both positionSize & indexTwap are in 10^18 already
        return positionSize.mul(indexTwap.toInt256()).divideBy10_18();
    }

    function _getIndexPrice(address token, uint256 twapInterval) private view returns (uint256) {
        return IIndexPrice(token).getIndexPrice(twapInterval);
    }

    function getTokenInfo(address trader, address token) public view returns (TokenInfo memory) {
        return _accountMap[trader].tokenInfoMap[token];
    }

    function getOpenNotional(address trader, address token) external view returns (int256) {
        return _accountMap[trader].openNotionalMap[token];
    }

    function getOwedRealizedPnl(address trader) external view returns (int256) {
        return _accountMap[trader].owedRealizedPnl;
    }

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder memory) {
        return
            _accountMap[trader].makerPositionMap[baseToken].openOrderMap[
                _getOrderId(trader, baseToken, lowerTick, upperTick)
            ];
    }

    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory) {
        return _accountMap[trader].makerPositionMap[baseToken].orderIds;
    }

    function getTotalTokenAmountInPool(address trader, address baseToken)
        public
        view
        returns (uint256 base, uint256 quote)
    {
        uint160 sqrtMarkPriceX96 = UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[baseToken]);
        base = _getTotalTokenAmountInPool(trader, baseToken, sqrtMarkPriceX96, true);
        quote = _getTotalTokenAmountInPool(trader, baseToken, sqrtMarkPriceX96, false);
    }

    function getPositionSize(address trader, address baseToken) public view returns (int256) {
        return _getPositionSize(trader, baseToken, UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[baseToken]));
    }

    // quote.available - quote.debt + totalQuoteFromEachPool - pendingFundingPayment
    function getNetQuoteBalance(address trader) public view returns (int256) {
        uint256 quoteInPool;
        uint256 tokenLen = _accountMap[trader].tokens.length;
        int256 fundingPayment;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            // TODO: remove quoteToken from _accountMap[trader].tokens?
            quoteInPool = quoteInPool.add(
                _getTotalTokenAmountInPool(
                    trader,
                    baseToken,
                    UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[baseToken]),
                    false // fetch quote token amount
                )
            );
            fundingPayment = fundingPayment.add(getPendingFundingPayment(trader, baseToken));
        }
        TokenInfo memory quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        int256 netQuoteBalance =
            quoteTokenInfo.available.toInt256().add(quoteInPool.toInt256()).sub(quoteTokenInfo.debt.toInt256()).sub(
                fundingPayment
            );
        return netQuoteBalance.abs() < _DUST ? 0 : netQuoteBalance;
    }

    function getNextFundingTime(address baseToken) external view returns (uint256) {
        return _nextFundingTimeMap[baseToken];
    }

    function getPremiumFraction(address baseToken, uint256 idx) external view returns (int256) {
        return _fundingHistoryMap[baseToken][idx].premiumFractions;
    }

    function getFundingHistoryLength(address baseToken) external view returns (uint256) {
        return _fundingHistoryMap[baseToken].length;
    }

    function getSqrtMarkPriceX96AtIndex(address baseToken, uint256 idx) external view returns (uint160) {
        return _fundingHistoryMap[baseToken][idx].sqrtMarkPriceX96;
    }

    /// @dev +: trader pays, -: trader receives
    function getPendingFundingPayment(address trader, address baseToken) public view returns (int256) {
        Account storage account = _accountMap[trader];
        int256 fundingPayment;
        {
            FundingHistory[] memory fundingHistory = _fundingHistoryMap[baseToken];
            uint256 indexEnd = fundingHistory.length;
            for (uint256 i = account.nextPremiumFractionIndexMap[baseToken]; i < indexEnd; i++) {
                int256 posSize = _getPositionSize(trader, baseToken, fundingHistory[i].sqrtMarkPriceX96);
                fundingPayment = fundingPayment.add(fundingHistory[i].premiumFractions.mul(posSize).divideBy10_18());
            }
        }
        return fundingPayment;
    }

    function getNextFundingIndex(address trader, address baseToken) external view returns (uint256) {
        return _accountMap[trader].nextPremiumFractionIndexMap[baseToken];
    }

    function getTotalUnrealizedPnl(address trader) public view returns (int256) {
        int256 totalPositionValue;
        uint256 tokenLen = _accountMap[trader].tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            if (_isPoolExistent(baseToken)) {
                totalPositionValue = totalPositionValue.add(getPositionValue(trader, baseToken, 0));
            }
        }

        return getNetQuoteBalance(trader).add(totalPositionValue);
    }

    //
    // INTERNAL FUNCTIONS
    //

    function _mint(
        address account,
        address token,
        uint256 amount,
        bool checkMarginRatio
    ) private returns (uint256) {
        if (amount == 0) {
            return 0;
        }
        if (token != quoteToken) {
            // Revise after we have defined the user-facing functions.
            _settleFunding(account, token);
        }

        // update internal states
        TokenInfo storage tokenInfo = _accountMap[account].tokenInfoMap[token];
        tokenInfo.available = tokenInfo.available.add(amount);
        tokenInfo.debt = tokenInfo.debt.add(amount);

        // check margin ratio must after minted
        if (checkMarginRatio) {
            _requireLargerThanInitialMarginRequirement(account);
        }

        IMintableERC20(token).mint(address(this), amount);

        emit Minted(account, token, amount);
        return amount;
    }

    // caller must ensure the token exists
    function _burn(
        address account,
        address token,
        uint256 amount
    ) private {
        if (amount == 0) {
            return;
        }

        if (token != quoteToken) {
            _settleFunding(account, token);
        }

        TokenInfo storage tokenInfo = _accountMap[account].tokenInfoMap[token];

        // CH_IBTB: insufficient balance to burn
        // can only burn the amount of debt that can be pay back with available
        require(amount <= Math.min(tokenInfo.debt, tokenInfo.available), "CH_IBTB");

        // pay back debt
        tokenInfo.available = tokenInfo.available.sub(amount);
        tokenInfo.debt = tokenInfo.debt.sub(amount);

        if (token != quoteToken) {
            _deregisterBaseToken(account, token);
        }

        IMintableERC20(token).burn(amount);

        emit Burned(account, token, amount);
    }

    // caller must ensure token is either base or quote and exists
    // mint max base or quote until the free collateral is zero
    function _mintMax(address trader, address token) private returns (uint256) {
        uint256 buyingPower = _getBuyingPower(trader);
        if (buyingPower == 0) {
            TokenInfo memory tokenInfo = getTokenInfo(trader, token);
            uint256 maximum = Math.max(tokenInfo.available, tokenInfo.debt);
            // TODO workaround here, if we use uint256.max, it may cause overflow in total supply
            // will remove this function and put the logic to uniswapV3SwapCallback
            // max of uint128 = (3.4028*10^20)*10^18
            return _mint(trader, token, type(uint128).max.toUint256().sub(maximum), false);
        }

        uint256 minted = buyingPower;
        if (token != quoteToken) {
            // TODO: change the valuation method && align with baseDebt()
            minted = FullMath.mulDiv(minted, 1 ether, _getIndexPrice(token, 0));
        }

        return _mint(trader, token, minted, false);
    }

    function _burnMax(address account, address token) private {
        TokenInfo memory tokenInfo = getTokenInfo(account, token);
        uint256 burnedAmount = Math.min(tokenInfo.available, tokenInfo.debt);
        if (burnedAmount > 0) {
            _burn(account, token, Math.min(burnedAmount, IERC20Metadata(token).balanceOf(address(this))));
        }
    }

    // expensive
    function _deregisterBaseToken(address account, address baseToken) private {
        // TODO add test: open long, add pool, now tokenInfo is cleared,
        TokenInfo memory tokenInfo = _accountMap[account].tokenInfoMap[baseToken];
        if (tokenInfo.available > 0 || tokenInfo.debt > 0) {
            return;
        }

        (uint256 baseInPool, uint256 quoteInPool) = getTotalTokenAmountInPool(account, baseToken);
        if (baseInPool > 0 || quoteInPool > 0) {
            return;
        }

        delete _accountMap[account].tokenInfoMap[baseToken];

        uint256 length = _accountMap[account].tokens.length;
        for (uint256 i; i < length; i++) {
            if (_accountMap[account].tokens[i] == baseToken) {
                // if the removal item is the last one, just `pop`
                if (i != length - 1) {
                    _accountMap[account].tokens[i] = _accountMap[account].tokens[length - 1];
                }
                _accountMap[account].tokens.pop();
                break;
            }
        }
    }

    function _registerBaseToken(address trader, address token) private {
        address[] memory tokens = _accountMap[trader].tokens;
        if (tokens.length == 0) {
            _accountMap[trader].tokens.push(token);
            return;
        }

        // if both available and debt == 0, token is not yet registered by any external function (ex: mint, burn, swap)
        TokenInfo memory tokenInfo = _accountMap[trader].tokenInfoMap[token];
        if (tokenInfo.available == 0 && tokenInfo.debt == 0) {
            bool hit;
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == token) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                _accountMap[trader].tokens.push(token);
            }
        }
    }

    // TODO refactor
    function _swapAndCalculateOpenNotional(InternalSwapParams memory params) private returns (SwapResponse memory) {
        int256 positionSize = getPositionSize(params.trader, params.baseToken);
        int256 oldOpenNotional = _accountMap[params.trader].openNotionalMap[params.baseToken];
        bool isOldPositionShort = positionSize < 0 ? true : false;
        SwapResponse memory response;
        int256 deltaAvailableQuote;

        // increase position if old/new position are in the same direction
        if (positionSize == 0 || isOldPositionShort == params.isBaseToQuote) {
            response = _swap(params);

            // TODO change _swap.response.deltaAvailableQuote to int
            // after swapCallback mint task
            deltaAvailableQuote = params.isBaseToQuote
                ? response.deltaAvailableQuote.toInt256()
                : -response.deltaAvailableQuote.toInt256();
            _accountMap[params.trader].openNotionalMap[params.baseToken] = oldOpenNotional.add(deltaAvailableQuote);
            return response;
        }

        // else: openReversePosition
        response = _swap(params);

        uint256 positionSizeAbs = positionSize.abs();

        // position size based closedRatio
        uint256 closedRatio = FullMath.mulDiv(response.deltaAvailableBase, 1 ether, positionSizeAbs);

        // TODO change _swap.response.deltaAvailableQuote to int
        deltaAvailableQuote = params.isBaseToQuote
            ? response.deltaAvailableQuote.toInt256()
            : -response.deltaAvailableQuote.toInt256();

        int256 realizedPnl;
        // reduce position if old position size is larger
        // or closedRatio > 1 ** baseToken.decimals
        if (positionSizeAbs > response.deltaAvailableBase) {
            // reduced ratio = abs(exchangedPosSize / takerPosSize)
            int256 reducedOpenNotional = oldOpenNotional.mul(closedRatio.toInt256()).divideBy10_18();
            _accountMap[params.trader].openNotionalMap[params.baseToken] = oldOpenNotional.sub(reducedOpenNotional);

            // alice long 1 ETH first, openNotional = -100
            // alice reduce 40% (short 0.4ETH), deltaAvailableBase = -0.4ETH, deltaAvailableQuote = 40 -> 50
            // reducedOpenNotional = -100 * 40% = -40
            // openNotional = -100 - (-40) = 60
            // realizedPnl = (40 -> 50) + (-40) = 10
            // realizedPnl = exchangedPositionNotional + reducedOpenNotional
            realizedPnl = deltaAvailableQuote.add(reducedOpenNotional);
        } else {
            // else: opens a larger reverse position
            int256 closedPositionNotional = deltaAvailableQuote.mul(1 ether).div(closedRatio.toInt256());
            int256 remainsPositionNotional = deltaAvailableQuote.sub(closedPositionNotional);

            // close position: openNotional = 0
            // then increase position: openNotional = remainsPositionNotional
            _accountMap[params.trader].openNotionalMap[params.baseToken] = remainsPositionNotional;

            realizedPnl = closedPositionNotional.add(oldOpenNotional);
        }

        _realizePnl(params.trader, realizedPnl);
        return response;
    }

    // caller must ensure there's enough quote available and debt
    function _realizePnl(address account, int256 deltaPnl) private {
        if (deltaPnl == 0) {
            return;
        }

        // TODO refactor with settle()
        _accountMap[account].owedRealizedPnl = _accountMap[account].owedRealizedPnl.add(deltaPnl);

        TokenInfo storage quoteTokenInfo = _accountMap[account].tokenInfoMap[quoteToken];
        uint256 deltaPnlAbs = deltaPnl.abs();
        // has profit
        if (deltaPnl > 0) {
            quoteTokenInfo.available = quoteTokenInfo.available.sub(deltaPnlAbs);
            IMintableERC20(quoteToken).burn(deltaPnlAbs);
            return;
        }

        // deltaPnl < 0 (has loss)
        quoteTokenInfo.debt = quoteTokenInfo.debt.sub(deltaPnlAbs);
    }

    function _swap(InternalSwapParams memory params) private returns (SwapResponse memory) {
        address trader = params.trader;
        address baseTokenAddr = params.baseToken;

        int256 fundingPayment = _settleFunding(trader, baseTokenAddr);

        address pool = _poolMap[baseTokenAddr];
        SwapState memory state =
            SwapState({
                tick: UniswapV3Broker.getTick(pool),
                sqrtPriceX96: UniswapV3Broker.getSqrtMarkPriceX96(pool),
                amountSpecifiedRemaining: 0,
                feeGrowthGlobalX128: _feeGrowthGlobalX128Map[baseTokenAddr],
                liquidity: UniswapV3Broker.getLiquidity(pool)
            });

        uint256 amount = params.amount;
        if (params.isBaseToQuote) {
            // mint extra base token before swap
            amount = FeeMath.calcScaledAmount(pool, params.amount, true);
        }

        UniswapV3Broker.SwapResponse memory response =
            UniswapV3Broker.swap(
                UniswapV3Broker.SwapParams(
                    pool,
                    params.isBaseToQuote,
                    params.isExactInput,
                    amount,
                    params.sqrtPriceLimitX96,
                    abi.encode(SwapCallbackData(trader, baseTokenAddr, params.mint))
                )
            );

        uint160 endingSqrtMarkPriceX96 = UniswapV3Broker.getSqrtMarkPriceX96(pool);
        // we are going to replay txs by swapping "exactOutput" with the output token received
        state.amountSpecifiedRemaining = params.isBaseToQuote
            ? -(response.quote.toInt256())
            : -(response.base.toInt256());

        uint24 uniswapFeeRatio = UniswapV3Broker.getUniswapFeeRatio(pool);

        // if there is residue in amountSpecifiedRemaining, makers can get a tiny little bit less than expected,
        // which is safer for the system
        while (state.amountSpecifiedRemaining != 0 && state.sqrtPriceX96 != endingSqrtMarkPriceX96) {
            SwapStep memory step;
            step.initialSqrtPriceX96 = state.sqrtPriceX96;

            // find next tick
            // note the search is bounded in one word
            (step.nextTick, step.isNextTickInitialized) = UniswapV3Broker.getNextInitializedTickWithinOneWord(
                pool,
                state.tick,
                UniswapV3Broker.getTickSpacing(pool),
                params.isBaseToQuote
            );

            // get the next price of this step (either next tick's price or the ending price)
            // use sqrtPrice instead of tick is more precise
            step.nextSqrtPriceX96 = TickMath.getSqrtRatioAtTick(step.nextTick);

            // find the next swap checkpoint
            // (either reached the next price of this step, or exhausted remaining amount specified)
            (state.sqrtPriceX96, , step.amountOut, ) = SwapMath.computeSwapStep(
                state.sqrtPriceX96,
                (
                    params.isBaseToQuote
                        ? step.nextSqrtPriceX96 < endingSqrtMarkPriceX96
                        : step.nextSqrtPriceX96 > endingSqrtMarkPriceX96
                )
                    ? endingSqrtMarkPriceX96
                    : step.nextSqrtPriceX96,
                state.liquidity,
                state.amountSpecifiedRemaining,
                uniswapFeeRatio
            );

            state.amountSpecifiedRemaining += step.amountOut.toInt256();

            // update CH's global fee growth if there is liquidity in this range
            // note CH only collects quote fee when swapping base -> quote
            if (state.liquidity > 0 && params.isBaseToQuote) {
                state.feeGrowthGlobalX128 += FullMath.mulDiv(
                    FullMath.mulDiv(step.amountOut, uniswapFeeRatio, 1e6),
                    FixedPoint128.Q128,
                    state.liquidity
                );
            }

            if (state.sqrtPriceX96 == step.nextSqrtPriceX96) {
                // we have reached the tick's boundary
                if (step.isNextTickInitialized) {
                    // update the tick if it has been initialized
                    mapping(int24 => uint256) storage tickMap = _feeGrowthOutsideX128TickMap[baseTokenAddr];
                    // according to the above updating logic,
                    // if isBaseToQuote, state.feeGrowthGlobalX128 will be updated; else, will never be updated
                    tickMap.cross(step.nextTick, state.feeGrowthGlobalX128);

                    int128 liquidityNet = UniswapV3Broker.getTickLiquidityNet(pool, step.nextTick);
                    if (params.isBaseToQuote) liquidityNet = -liquidityNet;
                    state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet);
                }

                state.tick = params.isBaseToQuote ? step.nextTick - 1 : step.nextTick;
            } else if (state.sqrtPriceX96 != step.initialSqrtPriceX96) {
                // update state.tick corresponding to the current price if the price has changed in this step
                state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }

        // only update global CH fee growth when swapping base -> quote
        // because otherwise the fee is collected by the uniswap pool instead
        if (params.isBaseToQuote) {
            // update global states since swap state transitions are all done
            _feeGrowthGlobalX128Map[baseTokenAddr] = state.feeGrowthGlobalX128;
        }

        // due to base to quote fee/ always charge fee from quote, fee is always (uniswapFeeRatios)% of response.quote
        uint256 fee = FullMath.mulDivRoundingUp(response.quote, uniswapFeeRatio, 1e6);
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        {
            // calculate exchangedPositionSize and exchangedPositionNotional
            TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[baseTokenAddr];
            TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];

            if (params.isBaseToQuote) {
                // short: exchangedPositionSize <= 0 && exchangedPositionNotional >= 0
                exchangedPositionSize = -(FeeMath.calcScaledAmount(pool, response.base, false).toInt256());
                // due to base to quote fee, exchangedPositionNotional contains the fee
                // s.t. we can take the fee away from exchangedPositionNotional(exchangedPositionNotional)
                exchangedPositionNotional = response.quote.toInt256();
            } else {
                // long: exchangedPositionSize >= 0 && exchangedPositionNotional <= 0
                exchangedPositionSize = response.base.toInt256();
                // as fee is charged by Uniswap pool already, exchangedPositionNotional does not include fee
                exchangedPositionNotional = -(response.quote.sub(fee).toInt256());
            }

            // update internal states
            // examples:
            // https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events?node-id=0%3A1
            baseTokenInfo.available = baseTokenInfo.available.toInt256().add(exchangedPositionSize).toUint256();
            quoteTokenInfo.available = quoteTokenInfo
                .available
                .toInt256()
                .add(exchangedPositionNotional)
                .toUint256()
                .sub(fee);
        }

        emit Swapped(
            trader,
            baseTokenAddr,
            exchangedPositionSize,
            exchangedPositionNotional,
            fee,
            fundingPayment,
            0 // TODO: badDebt
        );

        return
            SwapResponse(
                exchangedPositionSize.abs(), // deltaAvailableBase
                exchangedPositionNotional.sub(fee.toInt256()).abs(), // deltaAvailableQuote
                exchangedPositionSize.abs(),
                exchangedPositionNotional.abs()
            );
    }

    function _removeLiquidity(InternalRemoveLiquidityParams memory params)
        private
        returns (uint256 base, uint256 quote)
    {
        address trader = params.maker;

        _settleFunding(trader, params.baseToken);

        // load existing open order
        bytes32 orderId = _getOrderId(trader, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _accountMap[trader].makerPositionMap[params.baseToken].openOrderMap[orderId];
        // CH_ZL non-existent openOrder
        require(openOrder.liquidity > 0, "CH_NEO");
        // CH_NEL not enough liquidity
        require(params.liquidity <= openOrder.liquidity, "CH_NEL");

        address pool = _poolMap[params.baseToken];
        UniswapV3Broker.RemoveLiquidityResponse memory response;
        {
            uint256 baseBalanceBefore = IERC20Metadata(params.baseToken).balanceOf(address(this));
            response = UniswapV3Broker.removeLiquidity(
                UniswapV3Broker.RemoveLiquidityParams(pool, params.lowerTick, params.upperTick, params.liquidity)
            );
            // burn base fee
            // base fee of all makers in the range of lowerTick and upperTick should be
            // baseBalanceAfter - baseBalanceBefore - response.base
            uint256 baseBalanceAfter = IERC20Metadata(params.baseToken).balanceOf(address(this));
            IMintableERC20(params.baseToken).burn(baseBalanceAfter.sub(baseBalanceBefore).sub(response.base));

            base = response.base;
            quote = response.quote;
            // if flipped from initialized to uninitialized, clear the tick info
            if (!UniswapV3Broker.getIsTickInitialized(pool, params.lowerTick)) {
                _feeGrowthOutsideX128TickMap[params.baseToken].clear(params.lowerTick);
            }
            if (!UniswapV3Broker.getIsTickInitialized(pool, params.upperTick)) {
                _feeGrowthOutsideX128TickMap[params.baseToken].clear(params.upperTick);
            }
        }

        // update token info based on existing open order
        (uint256 quoteFeeClearingHouse, uint256 quoteFeeUniswap) =
            _removeLiquidityFromOrder(
                RemoveLiquidityFromOrderParams({
                    maker: trader,
                    baseToken: params.baseToken,
                    pool: pool,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    feeGrowthInsideQuoteX128: response.feeGrowthInsideQuoteX128,
                    liquidity: params.liquidity
                })
            );

        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        baseTokenInfo.available = baseTokenInfo.available.add(base);
        quoteTokenInfo.available = quoteTokenInfo.available.add(quoteFeeClearingHouse).add(quoteFeeUniswap).add(quote);

        // TODO move it back if we can fix stack too deep
        _emitLiquidityChanged(trader, params, response, quoteFeeClearingHouse.add(quoteFeeUniswap));
    }

    function _removeLiquidityFromOrder(RemoveLiquidityFromOrderParams memory params)
        private
        returns (uint256 quoteFeeClearingHouse, uint256 quoteFeeUniswap)
    {
        // update token info based on existing open order
        bytes32 orderId = _getOrderId(params.maker, params.baseToken, params.lowerTick, params.upperTick);
        mapping(int24 => uint256) storage tickMap = _feeGrowthOutsideX128TickMap[params.baseToken];
        OpenOrder storage openOrder =
            _accountMap[params.maker].makerPositionMap[params.baseToken].openOrderMap[orderId];
        uint256 feeGrowthInsideClearingHouseX128 =
            tickMap.getFeeGrowthInside(
                params.lowerTick,
                params.upperTick,
                UniswapV3Broker.getTick(params.pool),
                _feeGrowthGlobalX128Map[params.baseToken]
            );
        quoteFeeClearingHouse = _calcOwedFee(
            openOrder.liquidity,
            feeGrowthInsideClearingHouseX128,
            openOrder.feeGrowthInsideClearingHouseLastX128
        );
        quoteFeeUniswap = _calcOwedFee(
            openOrder.liquidity,
            params.feeGrowthInsideQuoteX128,
            openOrder.feeGrowthInsideUniswapLastX128
        );

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().sub(params.liquidity).toUint128();
        if (openOrder.liquidity == 0) {
            _removeOrder(params.maker, params.baseToken, orderId);
        } else {
            openOrder.feeGrowthInsideClearingHouseLastX128 = feeGrowthInsideClearingHouseX128;
            openOrder.feeGrowthInsideUniswapLastX128 = params.feeGrowthInsideQuoteX128;
        }
    }

    function _removeOrder(
        address maker,
        address baseToken,
        bytes32 orderId
    ) private {
        MakerPosition storage makerPosition = _accountMap[maker].makerPositionMap[baseToken];
        uint256 idx;
        for (idx = 0; idx < makerPosition.orderIds.length; idx++) {
            if (makerPosition.orderIds[idx] == orderId) {
                // found the existing order ID
                // remove it from the array efficiently by re-ordering and deleting the last element
                makerPosition.orderIds[idx] = makerPosition.orderIds[makerPosition.orderIds.length - 1];
                makerPosition.orderIds.pop();
                break;
            }
        }
        delete makerPosition.openOrderMap[orderId];
    }

    function _removeAllLiquidity(address maker, address baseToken) private {
        bytes32[] memory orderIds = _accountMap[maker].makerPositionMap[baseToken].orderIds;
        for (uint256 i = 0; i < orderIds.length; i++) {
            bytes32 orderId = orderIds[i];
            OpenOrder memory openOrder = _accountMap[maker].makerPositionMap[baseToken].openOrderMap[orderId];
            _removeLiquidity(
                InternalRemoveLiquidityParams(
                    maker,
                    baseToken,
                    openOrder.lowerTick,
                    openOrder.upperTick,
                    openOrder.liquidity
                )
            );
        }
    }

    function _openPosition(InternalOpenPositionParams memory params) private returns (SwapResponse memory) {
        SwapResponse memory swapResponse =
            _swapAndCalculateOpenNotional(
                InternalSwapParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    mint: true
                })
            );

        _burnMax(params.trader, params.baseToken);
        _burnMax(params.trader, quoteToken);

        // if this is the last position being closed, settle the remaining quote
        // must after burnMax(quote)
        if (_accountMap[params.trader].tokens.length == 0) {
            TokenInfo memory quoteTokenInfo = getTokenInfo(params.trader, quoteToken);
            _realizePnl(params.trader, quoteTokenInfo.available.toInt256().sub(quoteTokenInfo.debt.toInt256()));
        }

        if (!params.skipMarginRequirementCheck) {
            // it's not closing the position, check margin ratio
            _requireLargerThanInitialMarginRequirement(params.trader);
        }

        return swapResponse;
    }

    function _settleFunding(address trader, address baseToken) private returns (int256 fundingPayment) {
        uint256 historyLen = _fundingHistoryMap[baseToken].length;
        if (_accountMap[trader].nextPremiumFractionIndexMap[baseToken] == historyLen || historyLen == 0) {
            return 0;
        }

        fundingPayment = getPendingFundingPayment(trader, baseToken);
        _accountMap[trader].nextPremiumFractionIndexMap[baseToken] = historyLen;

        if (fundingPayment == 0) {
            return 0;
        }

        // settle funding to owedRealizedPnl
        _accountMap[trader].owedRealizedPnl = _accountMap[trader].owedRealizedPnl.sub(fundingPayment);

        emit FundingSettled(trader, baseToken, historyLen, fundingPayment);
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //

    // return decimals 18
    function _getTotalInitialMarginRequirement(address trader) internal view returns (uint256) {
        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = _accountMap[trader].tokenInfoMap[quoteToken].debt;
        uint256 totalPositionValue = _getTotalAbsPositionValue(trader);
        uint256 totalBaseDebtValue = _getTotalBaseDebtValue(trader);
        return Math.max(totalPositionValue, totalBaseDebtValue.add(quoteDebtValue)).mul(imRatio).divideBy10_18();
    }

    function _getTotalMinimumMarginRequirement(address trader) internal view returns (uint256) {
        return _getTotalAbsPositionValue(trader).mul(mmRatio).divideBy10_18();
    }

    function _getDebtValue(address token, uint256 amount) private view returns (uint256) {
        return amount.mul(_getIndexPrice(token, 0)).divideBy10_18();
    }

    function _getTotalTokenAmountInPool(
        address trader,
        address baseToken,
        uint160 sqrtMarkPriceX96,
        bool fetchBase // true: fetch base amount, false: fetch quote amount
    ) private view returns (uint256 tokenAmount) {
        Account storage account = _accountMap[trader];
        bytes32[] memory orderIds = account.makerPositionMap[baseToken].orderIds;

        //
        // tick:    lower             upper
        //       -|---+-----------------+---|--
        //     case 1                    case 2
        //
        // if current price < upper tick, maker has base
        // case 1 : current price < lower tick
        //  --> maker only has base token
        //
        // if current price > lower tick, maker has quote
        // case 2 : current price > upper tick
        //  --> maker only has quote token
        for (uint256 i = 0; i < orderIds.length; i++) {
            OpenOrder memory order = account.makerPositionMap[baseToken].openOrderMap[orderIds[i]];

            uint256 amount;
            {
                uint160 sqrtPriceAtLowerTick = TickMath.getSqrtRatioAtTick(order.lowerTick);
                uint160 sqrtPriceAtUpperTick = TickMath.getSqrtRatioAtTick(order.upperTick);
                if (fetchBase && sqrtMarkPriceX96 < sqrtPriceAtUpperTick) {
                    amount = UniswapV3Broker.getAmount0ForLiquidity(
                        sqrtMarkPriceX96 > sqrtPriceAtLowerTick ? sqrtMarkPriceX96 : sqrtPriceAtLowerTick,
                        sqrtPriceAtUpperTick,
                        order.liquidity
                    );
                } else if (!fetchBase && sqrtMarkPriceX96 > sqrtPriceAtLowerTick) {
                    amount = UniswapV3Broker.getAmount1ForLiquidity(
                        sqrtPriceAtLowerTick,
                        sqrtMarkPriceX96 < sqrtPriceAtUpperTick ? sqrtMarkPriceX96 : sqrtPriceAtUpperTick,
                        order.liquidity
                    );
                }
            }
            tokenAmount = tokenAmount.add(amount);

            if (!fetchBase) {
                int24 tick = TickMath.getTickAtSqrtRatio(sqrtMarkPriceX96);

                // uncollected quote fee in Uniswap pool
                uint256 feeGrowthInsideUniswapX128 =
                    UniswapV3Broker.getFeeGrowthInsideQuote(
                        _poolMap[baseToken],
                        order.lowerTick,
                        order.upperTick,
                        tick
                    );
                tokenAmount = tokenAmount.add(
                    _calcOwedFee(order.liquidity, feeGrowthInsideUniswapX128, order.feeGrowthInsideUniswapLastX128)
                );

                // uncollected quote fee in ClearingHouse
                mapping(int24 => uint256) storage tickMap = _feeGrowthOutsideX128TickMap[baseToken];
                uint256 feeGrowthGlobalX128 = _feeGrowthGlobalX128Map[baseToken];
                uint256 feeGrowthInsideClearingHouseX128 =
                    tickMap.getFeeGrowthInside(order.lowerTick, order.upperTick, tick, feeGrowthGlobalX128);

                tokenAmount = tokenAmount.add(
                    _calcOwedFee(
                        order.liquidity,
                        feeGrowthInsideClearingHouseX128,
                        order.feeGrowthInsideClearingHouseLastX128
                    )
                );
            }
        }
    }

    function _getPositionSize(
        address trader,
        address baseToken,
        uint160 sqrtMarkPriceX96
    ) private view returns (int256) {
        Account storage account = _accountMap[trader];
        uint256 vBaseAmount =
            account.tokenInfoMap[baseToken].available.add(
                _getTotalTokenAmountInPool(
                    trader,
                    baseToken,
                    sqrtMarkPriceX96,
                    true // get base token amount
                )
            );

        // NOTE: when a token goes into UniswapV3 pool (addLiquidity or swap), there would be 1 wei rounding error
        // for instance, maker adds liquidity with 2 base (2000000000000000000),
        // the actual base amount in pool would be 1999999999999999999
        int256 positionSize = vBaseAmount.toInt256().sub(account.tokenInfoMap[baseToken].debt.toInt256());
        return positionSize.abs() < _DUST ? 0 : positionSize;
    }

    function _isPoolExistent(address baseToken) internal view returns (bool) {
        return _poolMap[baseToken] != address(0);
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

    function _emitLiquidityChanged(
        address maker,
        AddLiquidityParams memory params,
        UniswapV3Broker.AddLiquidityResponse memory response,
        uint256 quoteFee
    ) private {
        emit LiquidityChanged(
            maker,
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            response.base.toInt256(),
            response.quote.toInt256(),
            response.liquidity.toInt128(),
            quoteFee
        );
    }

    function _emitLiquidityChanged(
        address maker,
        InternalRemoveLiquidityParams memory params,
        UniswapV3Broker.RemoveLiquidityResponse memory response,
        uint256 quoteFee
    ) private {
        emit LiquidityChanged(
            maker,
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            -response.base.toInt256(),
            -response.quote.toInt256(),
            -params.liquidity.toInt128(),
            quoteFee
        );
    }

    function _requireHasBaseToken(address baseToken) private view {
        // CH_BTNE: base token not exists
        require(_isPoolExistent(baseToken), "CH_BTNE");
    }

    function _requireLargerThanInitialMarginRequirement(address trader) private view {
        // CH_NEAV: not enough account value
        require(
            getAccountValue(trader).gte(_getTotalInitialMarginRequirement(trader).toInt256(), _settlementTokenDecimals),
            "CH_NEAV"
        );
    }
}
