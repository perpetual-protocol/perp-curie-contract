// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { Validation } from "./base/Validation.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ISettlement } from "./interface/ISettlement.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { IVault } from "./interface/IVault.sol";
import { Exchange } from "./Exchange.sol";
import { TokenBalance } from "./lib/TokenBalance.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";

contract ClearingHouse is
    IUniswapV3MintCallback,
    IUniswapV3SwapCallback,
    ISettlement,
    ReentrancyGuard,
    Validation,
    OwnerPausable,
    BaseRelayRecipient
{
    using SafeMath for uint256;
    using SafeMath for uint160;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using SignedSafeMath for int256;
    using PerpSafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using TokenBalance for TokenBalance.Info;
    using AccountMarket for mapping(address => mapping(address => AccountMarket.Info));
    using AccountMarket for AccountMarket.Info;

    //
    // events
    //
    event Minted(address indexed trader, address indexed token, uint256 amount);
    event Burned(address indexed trader, address indexed token, uint256 amount);

    event PositionChanged(
        address indexed trader,
        address indexed baseToken,
        int256 exchangedPositionSize,
        int256 exchangedPositionNotional,
        uint256 fee,
        int256 openNotional,
        int256 realizedPnl
    );
    event PositionLiquidated(
        address indexed trader,
        address indexed baseToken,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator
    );
    event FundingPaymentSettled(
        address indexed trader,
        address indexed baseToken,
        int256 amount // +: trader pays, -: trader receives
    );
    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);
    event TwapIntervalChanged(uint256 twapInterval);
    event LiquidationPenaltyRatioChanged(uint24 liquidationPenaltyRatio);
    event PartialCloseRatioChanged(uint24 partialCloseRatio);
    event ReferredPositionChanged(bytes32 indexed referralCode);
    event ExchangeChanged(address exchange);
    event MaxMarketsPerAccountChanged(uint8 maxMarketsPerAccount);

    //
    // Struct
    //

    struct Account {
        // realized pnl but haven't settle to collateral, vToken decimals
        int256 owedRealizedPnl;
        address[] tokens; // all tokens (base only) this account is in debt of
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

    struct InternalRemoveLiquidityParams {
        address maker;
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct RemoveLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        uint256 liquidity;
    }

    struct InternalSwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        Funding.Growth updatedGlobalFundingGrowth;
    }

    struct SwapResponse {
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        int256 exchangedPositionSize;
        int256 exchangedPositionNotional;
        uint256 fee;
        int256 openNotional;
        int256 realizedPnl;
        int24 tick;
    }

    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
        // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
        // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
        // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
        // when it's 0 in exactInput, means ignore slippage protection
        // when it's maxUint in exactOutput = ignore
        // when it's over or under the bound, it will be reverted
        uint256 oppositeAmountBound;
        uint256 deadline;
        // B2Q: the price cannot be less than this value after the swap
        // Q2B: The price cannot be greater than this value after the swap
        // it will fill the trade until it reach the price limit instead of reverted
        uint160 sqrtPriceLimitX96;
        bytes32 referralCode;
    }

    struct InternalOpenPositionParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool skipMarginRequirementCheck;
        Funding.Growth updatedGlobalFundingGrowth;
    }

    struct AfterRemoveLiquidityParams {
        address maker;
        address baseToken;
        uint256 removedBase;
        uint256 removedQuote;
        uint256 collectedFee;
    }

    struct ClosePositionParams {
        address baseToken;
        uint160 sqrtPriceLimitX96;
        uint256 oppositeAmountBound;
        uint256 deadline;
        bytes32 referralCode;
    }

    struct InternalClosePositionParams {
        address trader;
        address baseToken;
        uint160 sqrtPriceLimitX96;
        Funding.Growth updatedGlobalFundingGrowth;
    }

    struct CheckSlippageParams {
        bool isBaseToQuote;
        bool isExactInput;
        uint256 deltaAvailableQuote;
        uint256 deltaAvailableBase;
        uint256 oppositeAmountBound;
    }

    // not used in CH, due to inherit from BaseRelayRecipient
    string public override versionRecipient;
    // 10 wei
    uint256 internal constant _DUST = 10;

    //
    // state variables
    //
    address public immutable quoteToken;
    address public immutable uniswapV3Factory;
    address public vault;
    address public insuranceFund;
    address public exchange;

    uint24 public imRatio = 10e4; // initial-margin ratio, 10%
    uint24 public mmRatio = 6.25e4; // minimum-margin ratio, 6.25%

    uint24 public liquidationPenaltyRatio = 2.5e4; // initial penalty ratio, 2.5%
    uint24 public partialCloseRatio = 25e4; // partial close ratio, 25%
    uint8 public maxMarketsPerAccount;

    // cached the settlement token's decimal for gas optimization
    // owner must ensure the settlement token's decimal is not immutable
    uint8 internal immutable _settlementTokenDecimals;

    uint32 public twapInterval = 15 minutes;

    // key: trader
    mapping(address => Account) internal _accountMap;

    // first key: trader, second key: baseToken
    mapping(address => mapping(address => AccountMarket.Info)) internal _accountMarketMap;

    // first key: trader, second key: baseToken
    // value: the last timestamp when a trader exceeds price limit when closing a position/being liquidated
    mapping(address => mapping(address => uint256)) internal _lastOverPriceLimitTimestampMap;

    // key: base token
    mapping(address => uint256) internal _firstTradedTimestampMap;
    mapping(address => uint256) internal _lastSettledTimestampMap;
    mapping(address => Funding.Growth) internal _globalFundingGrowthX96Map;

    // key: base token
    // value: a threshold to limit the price impact per block when reducing or closing the position
    mapping(address => uint24) private _maxTickCrossedWithinBlockMap;
    // value: tick from the last tx; used for comparing if a tx exceeds maxTickCrossedWithinBlock
    mapping(address => int24) internal _lastUpdatedTickMap;

    constructor(
        address vaultArg,
        address insuranceFundArg,
        address quoteTokenArg,
        address uniV3FactoryArg
    ) public {
        // vault is 0
        require(vaultArg != address(0), "CH_VI0");
        // InsuranceFund is 0
        require(insuranceFundArg != address(0), "CH_IFI0");

        // TODO check quoteToken's balance once this is upgradable
        // quoteToken is 0
        require(quoteTokenArg != address(0), "CH_QI0");
        // CH_QDN18: quoteToken decimals is not 18
        require(IERC20Metadata(quoteTokenArg).decimals() == 18, "CH_QDN18");

        // uniV3Factory is 0
        require(uniV3FactoryArg != address(0), "CH_U10");

        vault = vaultArg;
        insuranceFund = insuranceFundArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;

        _settlementTokenDecimals = IVault(vault).decimals();
    }

    //
    // MODIFIER
    //
    modifier checkRatio(uint24 ratio) {
        // CH_RL1: ratio overflow
        require(ratio <= 1e6, "CH_RO");
        _;
    }

    modifier onlyExchange() {
        // only exchange
        require(_msgSender() == exchange, "CH_OE");
        _;
    }

    //
    // EXTERNAL ADMIN FUNCTIONS
    //
    function setExchange(address exchangeArg) external onlyOwner {
        // exchange is 0
        require(exchangeArg != address(0), "CH_EI0");
        exchange = exchangeArg;
        emit ExchangeChanged(exchange);
    }

    function setMaxTickCrossedWithinBlock(address baseToken, uint24 maxTickCrossedWithinBlock) external onlyOwner {
        _requireHasBaseToken(baseToken);

        // CH_MTO: max tick crossed limit out of range
        // tick range is [-MAX_TICK, MAX_TICK], maxTickCrossedWithinBlock should be in [0, MAX_TICK]
        require(maxTickCrossedWithinBlock <= uint24(TickMath.MAX_TICK), "CH_MTCLOOR");

        _maxTickCrossedWithinBlockMap[baseToken] = maxTickCrossedWithinBlock;
    }

    function setTwapInterval(uint32 twapIntervalArg) external onlyOwner {
        // CH_ITI: invalid twapInterval
        require(twapIntervalArg != 0, "CH_ITI");

        twapInterval = twapIntervalArg;
        emit TwapIntervalChanged(twapIntervalArg);
    }

    function setLiquidationPenaltyRatio(uint24 liquidationPenaltyRatioArg)
        external
        checkRatio(liquidationPenaltyRatioArg)
        onlyOwner
    {
        liquidationPenaltyRatio = liquidationPenaltyRatioArg;
        emit LiquidationPenaltyRatioChanged(liquidationPenaltyRatioArg);
    }

    function setPartialCloseRatio(uint24 partialCloseRatioArg) external checkRatio(partialCloseRatioArg) onlyOwner {
        partialCloseRatio = partialCloseRatioArg;
        emit PartialCloseRatioChanged(partialCloseRatioArg);
    }

    function setMaxMarketsPerAccount(uint8 maxMarketsPerAccountArg) external onlyOwner {
        maxMarketsPerAccount = maxMarketsPerAccountArg;
        emit MaxMarketsPerAccountChanged(maxMarketsPerAccountArg);
    }

    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        _setTrustedForwarder(trustedForwarderArg);
    }

    //
    // EXTERNAL ONLY EXCHANGE
    //
    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data // contains baseToken
    ) external override onlyExchange {
        Exchange.MintCallbackData memory callbackData = abi.decode(data, (Exchange.MintCallbackData));

        if (amount0Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token0();
            _mintIfNotEnough(callbackData.trader, token, amount0Owed);
            TransferHelper.safeTransfer(token, callbackData.pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            address token = IUniswapV3Pool(callbackData.pool).token1();
            _mintIfNotEnough(callbackData.trader, token, amount1Owed);
            TransferHelper.safeTransfer(token, callbackData.pool, amount1Owed);
        }
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override onlyExchange {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_F0S: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        Exchange.SwapCallbackData memory callbackData = abi.decode(data, (Exchange.SwapCallbackData));
        IUniswapV3Pool uniswapV3Pool = IUniswapV3Pool(callbackData.pool);

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0
                ? (uniswapV3Pool.token0(), uint256(amount0Delta))
                : (uniswapV3Pool.token1(), uint256(amount1Delta));

        // we know the exact amount of a token needed for swap in the swap callback
        // we separate into two part
        // 1. extra minted tokens because the fee is charged by CH now
        // 2. tokens that a trader needs when openPosition
        //
        // check here for the design of custom fee
        // https://www.notion.so/perp/Customise-fee-tier-on-B2QFee-1b7244e1db63416c8651e8fa04128cdb

        // 1. fee charged by CH
        // because the amountToPay is scaled up,
        // we need to scale down the amount to get the exact user's input amount
        // the difference of these two values is minted for compensate the base/quote fee
        // here is an example for custom fee
        //  - clearing house fee: 2%, uniswap fee: 1%, use input with exact input: 1 quote
        //    our input to uniswap pool will be 1 * 0.98 / 0.99, and amountToPay is the same
        //    the `exactSwappedAmount` is (1 * 0.98 / 0.99) * 0.99 = 0.98
        //    the fee for uniswap pool is (1 * 0.98 / 0.99) * 0.01  <-- we need to mint
        uint256 exactSwappedAmount =
            FeeMath.calcAmountScaledByFeeRatio(amountToPay, callbackData.uniswapFeeRatio, false);

        // 2. openPosition
        uint256 availableBefore = _accountMarketMap.getAvailable(callbackData.trader, token);
        // if quote to base, need to mint clearing house quote fee for trader
        uint256 amount =
            token == callbackData.baseToken ? exactSwappedAmount : exactSwappedAmount.add(callbackData.fee);

        if (availableBefore < amount) {
            _mint(callbackData.trader, token, amount.sub(availableBefore), false);
        }

        // swap
        TransferHelper.safeTransfer(token, address(callbackData.pool), amountToPay);
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function addLiquidity(AddLiquidityParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (AddLiquidityResponse memory)
    {
        _requireHasBaseToken(params.baseToken);

        address trader = _msgSender();
        // register token if it's the first time
        _registerBaseToken(trader, params.baseToken);

        Funding.Growth memory updatedGlobalFundingGrowth =
            _settleFundingAndUpdateFundingGrowth(trader, params.baseToken);

        // note that we no longer check available tokens here because CH will always auto-mint
        // when requested by UniswapV3MintCallback
        Exchange.AddLiquidityResponse memory response =
            Exchange(exchange).addLiquidity(
                Exchange.AddLiquidityParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    base: params.base,
                    quote: params.quote,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    updatedGlobalFundingGrowth: updatedGlobalFundingGrowth
                })
            );

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");

        // update token info
        // TODO should burn base fee received instead of adding it to available amount

        _accountMarketMap.addAvailable(trader, quoteToken, response.fee.toInt256().sub(response.quote.toInt256()));
        _accountMarketMap.addAvailable(trader, params.baseToken, -(response.base.toInt256()));
        _accountMarketMap.addOpenNotionalFraction(trader, params.baseToken, response.quote.toInt256());

        // must after token info is updated to ensure free collateral is positive after updated
        _requireEnoughFreeCollateral(trader);

        return
            AddLiquidityResponse({
                base: response.base,
                quote: response.quote,
                fee: response.fee,
                liquidity: response.liquidity
            });
    }

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (RemoveLiquidityResponse memory response)
    {
        _requireHasBaseToken(params.baseToken);
        response = _removeLiquidity(
            InternalRemoveLiquidityParams({
                maker: _msgSender(),
                baseToken: params.baseToken,
                lowerTick: params.lowerTick,
                upperTick: params.upperTick,
                liquidity: params.liquidity
            })
        );

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");
    }

    function closePosition(ClosePositionParams calldata params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        _requireHasBaseToken(params.baseToken);

        address trader = _msgSender();
        Funding.Growth memory updatedGlobalFundingGrowth =
            _settleFundingAndUpdateFundingGrowth(trader, params.baseToken);

        SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    updatedGlobalFundingGrowth: updatedGlobalFundingGrowth
                })
            );

        // TODO scale up or down the opposite amount bound if it's a partial close
        // if oldPositionSize is long, close a long position is short, B2Q
        // if oldPositionSize is short, close a short position is long, Q2B
        bool isBaseToQuote = _getPositionSize(trader, params.baseToken) > 0 ? true : false;
        _checkSlippage(
            CheckSlippageParams({
                isBaseToQuote: isBaseToQuote,
                isExactInput: true,
                deltaAvailableQuote: response.deltaAvailableQuote,
                deltaAvailableBase: response.deltaAvailableBase,
                oppositeAmountBound: params.oppositeAmountBound
            })
        );

        emit ReferredPositionChanged(params.referralCode);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    function openPosition(OpenPositionParams memory params)
        external
        whenNotPaused
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        address trader = _msgSender();

        _requireHasBaseToken(params.baseToken);
        _registerBaseToken(trader, params.baseToken);

        // must before price impact check
        Funding.Growth memory updatedGlobalFundingGrowth =
            _settleFundingAndUpdateFundingGrowth(trader, params.baseToken);

        // cache before actual swap
        bool isReducePosition = !_isIncreasePosition(trader, params.baseToken, params.isBaseToQuote);
        SwapResponse memory response =
            _openPosition(
                InternalOpenPositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: false,
                    updatedGlobalFundingGrowth: updatedGlobalFundingGrowth
                })
            );

        if (isReducePosition) {
            // revert if isOverPriceLimit to avoid that partially closing a position in openPosition() seems unexpected
            // CH_OPI: over price impact
            require(
                !_isOverPriceLimit(params.baseToken, _maxTickCrossedWithinBlockMap[params.baseToken], response.tick),
                "CH_OPI"
            );
        }

        _checkSlippage(
            CheckSlippageParams({
                isBaseToQuote: params.isBaseToQuote,
                isExactInput: params.isExactInput,
                deltaAvailableQuote: response.deltaAvailableQuote,
                deltaAvailableBase: response.deltaAvailableBase,
                oppositeAmountBound: params.oppositeAmountBound
            })
        );

        emit ReferredPositionChanged(params.referralCode);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    function liquidate(address trader, address baseToken) external whenNotPaused nonReentrant {
        _requireHasBaseToken(baseToken);
        // per liquidation specs:
        //   https://www.notion.so/perp/Perpetual-Swap-Contract-s-Specs-Simulations-96e6255bf77e4c90914855603ff7ddd1
        //
        // liquidation trigger:
        //   accountMarginRatio < accountMaintenanceMarginRatio
        //   => accountValue / sum(abs(positionValue_market)) <
        //        sum(mmRatio * abs(positionValue_market)) / sum(abs(positionValue_market))
        //   => accountValue < sum(mmRatio * abs(positionValue_market))
        //   => accountValue < sum(abs(positionValue_market)) * mmRatio = totalMinimumMarginRequirement
        //
        // CH_EAV: enough account value
        require(
            getAccountValue(trader).lt(
                _getTotalAbsPositionValue(trader).mulRatio(mmRatio).toInt256(),
                _settlementTokenDecimals
            ),
            "CH_EAV"
        );

        // CH_NEO: not empty order
        require(!Exchange(exchange).hasOrder(trader, _accountMap[trader].tokens), "CH_NEO");

        Funding.Growth memory updatedGlobalFundingGrowth = _settleFundingAndUpdateFundingGrowth(trader, baseToken);
        SwapResponse memory response =
            _closePosition(
                InternalClosePositionParams({
                    trader: trader,
                    baseToken: baseToken,
                    sqrtPriceLimitX96: 0,
                    updatedGlobalFundingGrowth: updatedGlobalFundingGrowth
                })
            );

        // trader's pnl-- as liquidation penalty
        uint256 liquidationFee = response.exchangedPositionNotional.abs().mulRatio(liquidationPenaltyRatio);
        _accountMap[trader].owedRealizedPnl = _accountMap[trader].owedRealizedPnl.sub(liquidationFee.toInt256());

        // increase liquidator's pnl liquidation reward
        address liquidator = _msgSender();
        _accountMap[liquidator].owedRealizedPnl = _accountMap[liquidator].owedRealizedPnl.add(
            liquidationFee.toInt256()
        );

        emit PositionLiquidated(
            trader,
            baseToken,
            response.exchangedPositionNotional.abs(),
            response.deltaAvailableBase,
            liquidationFee,
            liquidator
        );
    }

    function cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external whenNotPaused nonReentrant {
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    function cancelAllExcessOrders(address maker, address baseToken) external whenNotPaused nonReentrant {
        bytes32[] memory orderIds = Exchange(exchange).getOpenOrderIds(maker, baseToken);
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    /// @dev settle() would be called by Vault.withdraw()
    function settle(address trader) external override returns (int256) {
        // only vault
        require(_msgSender() == vault, "CH_OV");

        // the full process of a trader's withdrawal:
        // for loop of each order:
        //     call CH.removeLiquidity(baseToke, lowerTick, upperTick, 0)
        //         settle funding payment to owedRealizedPnl
        //         collect fee to owedRealizedPnl
        // call Vault.withdraw(token, amount)
        //     settle pnl to trader balance in Vault
        //     transfer amount to trader

        // make sure funding payments are always settled,
        // while fees are ok to let maker decides whether to collect using CH.removeLiquidity(0)
        for (uint256 i = 0; i < _accountMap[trader].tokens.length; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            if (_hasPool(baseToken)) {
                _settleFundingAndUpdateFundingGrowth(trader, baseToken);
            }
        }

        Account storage accountStorage = _accountMap[trader];
        int256 pnl = _accountMap[trader].owedRealizedPnl;
        accountStorage.owedRealizedPnl = 0;

        if (accountStorage.tokens.length > 0) {
            return pnl;
        }

        // settle quote when all positions are closed (accountStorage.tokens.length == 0)
        int256 quotePnl = _accountMarketMap.getTokenBalance(trader, quoteToken).getNet();
        if (quotePnl > 0) {
            // profit
            _accountMarketMap.addAvailable(trader, quoteToken, -quotePnl);
        } else {
            // loss
            _accountMarketMap.addDebt(trader, quoteToken, -quotePnl);
        }

        return pnl.add(quotePnl);
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint24) {
        return _maxTickCrossedWithinBlockMap[baseToken];
    }

    // return in settlement token decimals
    function getAccountValue(address account) public view returns (int256) {
        return _getTotalCollateralValue(account).addS(getTotalUnrealizedPnl(account), _settlementTokenDecimals);
    }

    // (totalBaseDebtValue + totalQuoteDebtValue) * imRatio
    function getTotalOpenOrderMarginRequirement(address trader) external view returns (uint256) {
        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = _accountMarketMap.getDebt(trader, quoteToken);
        return _getTotalBaseDebtValue(trader).add(quoteDebtValue).mul(imRatio);
    }

    /// @dev a negative returned value is only be used when calculating pnl
    function getPositionValue(address trader, address token) external view returns (int256) {
        return _getPositionValue(trader, token);
    }

    function getTokenInfo(address trader, address token) external view returns (TokenBalance.Info memory) {
        return _accountMarketMap.getTokenBalance(trader, token);
    }

    function getOpenNotional(address trader, address baseToken) public view returns (int256) {
        // quote.pool[baseToken] + quote.owedFee[baseToken] - openNotionalFraction[baseToken]
        int256 quoteInPool = Exchange(exchange).getTotalTokenAmountInPool(trader, baseToken, false).toInt256();
        int256 openNotionalFraction = _accountMarketMap[trader][baseToken].openNotionalFraction;
        return quoteInPool.sub(openNotionalFraction);
    }

    function getOwedRealizedPnl(address trader) external view returns (int256) {
        return _accountMap[trader].owedRealizedPnl;
    }

    function getPositionSize(address trader, address baseToken) public view returns (int256) {
        return _getPositionSize(trader, baseToken);
    }

    // quote.available - quote.debt + totalQuoteInPools - pendingFundingPayment
    function getNetQuoteBalance(address trader) public view returns (int256) {
        // include pendingFundingPayment
        uint256 totalQuoteInPools = Exchange(exchange).getTotalQuoteAmountInPools(trader, _accountMap[trader].tokens);

        int256 netQuoteBalance =
            _accountMarketMap.getTokenBalance(trader, quoteToken).getNet().add(totalQuoteInPools.toInt256());
        return netQuoteBalance.abs() < _DUST ? 0 : netQuoteBalance;
    }

    /// @return fundingPayment > 0 is payment and < 0 is receipt
    function getPendingFundingPayment(address trader, address baseToken) public view returns (int256) {
        _requireHasBaseToken(baseToken);
        (Funding.Growth memory updatedGlobalFundingGrowth, , ) = _getUpdatedGlobalFundingGrowth(baseToken);
        return _getPendingFundingPayment(trader, baseToken, updatedGlobalFundingGrowth);
    }

    /// @return fundingPayment > 0 is payment and < 0 is receipt
    function getAllPendingFundingPayment(address trader) external view returns (int256) {
        return _getAllPendingFundingPayment(trader);
    }

    function getTotalUnrealizedPnl(address trader) public view returns (int256) {
        int256 totalPositionValue;
        for (uint256 i = 0; i < _accountMap[trader].tokens.length; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            if (_hasPool(baseToken)) {
                totalPositionValue = totalPositionValue.add(_getPositionValue(trader, baseToken));
            }
        }

        return getNetQuoteBalance(trader).add(totalPositionValue);
    }

    // return decimals 18
    function getTotalInitialMarginRequirement(address trader) external view returns (uint256) {
        return _getTotalInitialMarginRequirement(trader);
    }

    //
    // INTERNAL FUNCTIONS
    //

    function _mint(
        address account,
        address token,
        uint256 amount,
        bool checkMarginRatio
    ) internal returns (uint256) {
        if (amount == 0) {
            return 0;
        }

        // update internal states
        _accountMarketMap.addAvailable(account, token, amount);
        _accountMarketMap.addDebt(account, token, amount);

        // check margin ratio must after minted
        if (checkMarginRatio) {
            _requireEnoughFreeCollateral(account);
        }

        emit Minted(account, token, amount);
        return amount;
    }

    // mint more token if the trader does not have more than the specified amount available
    function _mintIfNotEnough(
        address account,
        address token,
        uint256 amount
    ) internal {
        uint256 availableBefore = _accountMarketMap.getAvailable(account, token);
        if (availableBefore < amount) {
            _mint(account, token, amount.sub(availableBefore), false);
        }
    }

    // caller must ensure the token exists, burn the debt or available of trader to zero
    function _burn(address trader, address token) internal {
        uint256 amount = _accountMarketMap.getTokenBalance(trader, token).getBurnable();
        if (amount == 0) {
            return;
        }

        // pay back debt
        _accountMarketMap.addAvailable(trader, token, -(amount.toInt256()));
        _accountMarketMap.addDebt(trader, token, -(amount.toInt256()));

        if (token != quoteToken) {
            _deregisterBaseToken(trader, token);
        }

        emit Burned(trader, token, amount);
    }

    function _cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] memory orderIds
    ) internal {
        _requireHasBaseToken(baseToken);

        // CH_EFC: enough free collateral
        // only cancel open orders if there are not enough free collateral
        require(_getFreeCollateral(maker) < 0, "CH_EFC");

        // must settle funding before getting token info
        _settleFundingAndUpdateFundingGrowth(maker, baseToken);
        Exchange.RemoveLiquidityResponse memory response =
            Exchange(exchange).removeLiquidityByIds(maker, baseToken, orderIds);
        _afterRemoveLiquidity(
            AfterRemoveLiquidityParams({
                maker: maker,
                baseToken: baseToken,
                removedBase: response.base,
                removedQuote: response.quote,
                collectedFee: response.fee
            })
        );
    }

    function _afterRemoveLiquidity(AfterRemoveLiquidityParams memory params) internal {
        // collect fee to owedRealizedPnl
        _accountMap[params.maker].owedRealizedPnl = _accountMap[params.maker].owedRealizedPnl.add(
            params.collectedFee.toInt256()
        );

        _accountMarketMap.addAvailable(params.maker, quoteToken, params.removedQuote);
        _accountMarketMap.addAvailable(params.maker, params.baseToken, params.removedBase);
        _accountMarketMap.addOpenNotionalFraction(params.maker, params.baseToken, -(params.removedQuote.toInt256()));

        // burn maker's debt to reduce maker's init margin requirement
        _burn(params.maker, params.baseToken);

        // burn maker's quote to reduce maker's init margin requirement
        _burn(params.maker, quoteToken);
    }

    // expensive
    function _deregisterBaseToken(address trader, address baseToken) internal {
        // TODO add test: open long, add pool, now tokenInfo is cleared,
        if (!_accountMarketMap.getTokenBalance(trader, baseToken).isZero()) {
            return;
        }

        uint256 baseInPool = Exchange(exchange).getTotalTokenAmountInPool(trader, baseToken, true);
        uint256 quoteInPool = Exchange(exchange).getTotalTokenAmountInPool(trader, baseToken, false);
        if (baseInPool > 0 || quoteInPool > 0) {
            return;
        }

        _accountMarketMap.clear(trader, baseToken);

        uint256 length = _accountMap[trader].tokens.length;
        for (uint256 i; i < length; i++) {
            if (_accountMap[trader].tokens[i] == baseToken) {
                // if the removal item is the last one, just `pop`
                if (i != length - 1) {
                    _accountMap[trader].tokens[i] = _accountMap[trader].tokens[length - 1];
                }
                _accountMap[trader].tokens.pop();
                break;
            }
        }
    }

    function _registerBaseToken(address trader, address token) internal {
        address[] memory tokens = _accountMap[trader].tokens;
        if (tokens.length == 0) {
            _accountMap[trader].tokens.push(token);
            return;
        }

        // if both available and debt == 0, token is not yet registered by any external function (ex: mint, burn, swap)
        if (_accountMarketMap.getTokenBalance(trader, token).isZero()) {
            bool hit;
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == token) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                // CH_MNE: markets number exceeded
                require(maxMarketsPerAccount == 0 || tokens.length < maxMarketsPerAccount, "CH_MNE");
                _accountMap[trader].tokens.push(token);
            }
        }
    }

    // TODO refactor
    function _swapAndCalculateOpenNotional(InternalSwapParams memory params) internal returns (SwapResponse memory) {
        int256 positionSize = getPositionSize(params.trader, params.baseToken);
        int256 oldOpenNotional = getOpenNotional(params.trader, params.baseToken);
        SwapResponse memory response;
        int256 deltaAvailableQuote;

        // if increase position (old / new position are in the same direction)
        if (_isIncreasePosition(params.trader, params.baseToken, params.isBaseToQuote)) {
            response = _swap(params);

            // TODO change _swap.response.deltaAvailableQuote to int
            // after swapCallback mint task
            deltaAvailableQuote = params.isBaseToQuote
                ? response.deltaAvailableQuote.toInt256()
                : -response.deltaAvailableQuote.toInt256();

            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=813431512
            // taker:
            // step 1: long 20 base
            // deltaAvailableQuote = -252.53
            // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
            //                      = 0 - (-252.53) + 0 = 252.53
            // openNotional = -openNotionalFraction = -252.53
            _accountMarketMap.addOpenNotionalFraction(params.trader, params.baseToken, -deltaAvailableQuote);
            response.openNotional = getOpenNotional(params.trader, params.baseToken);

            // there is no realizedPnl when increasing position
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
        // if reduce or close position (closeRatio <= 1)
        if (positionSizeAbs >= response.deltaAvailableBase) {
            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=148137350
            // taker:
            // step 1: long 20 base
            // openNotionalFraction = 252.53
            // openNotional = -252.53
            // step 2: short 10 base (reduce half of the position)
            // deltaAvailableQuote = 137.5
            // closeRatio = 10/20 = 0.5
            // reducedOpenNotional = oldOpenNotional * closedRatio = -252.53 * 0.5 = -126.265
            // realizedPnl = deltaAvailableQuote + reducedOpenNotional = 137.5 + -126.265 = 11.235
            // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
            //                      = 252.53 - 137.5 + 11.235 = 126.265
            // openNotional = -openNotionalFraction = 126.265
            int256 reducedOpenNotional = oldOpenNotional.mul(closedRatio.toInt256()).divBy10_18();
            realizedPnl = deltaAvailableQuote.add(reducedOpenNotional);
        } else {
            // else, open a larger reverse position

            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=668982944
            // taker:
            // step 1: long 20 base
            // openNotionalFraction = 252.53
            // openNotional = -252.53
            // step 2: short 30 base (open a larger reverse position)
            // deltaAvailableQuote = 337.5
            // closeRatio = 30/20 = 1.5
            // closedPositionNotional = deltaAvailableQuote / closeRatio = 337.5 / 1.5 = 225
            // remainsPositionNotional = deltaAvailableQuote - closedPositionNotional = 337.5 - 225 = 112.5
            // realizedPnl = closedPositionNotional + oldOpenNotional = -252.53 + 225 = -27.53
            // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
            //                      = 252.53 - 337.5 + -27.53 = -112.5
            // openNotional = -openNotionalFraction = remainsPositionNotional = 112.5
            int256 closedPositionNotional = deltaAvailableQuote.mul(1 ether).div(closedRatio.toInt256());
            realizedPnl = oldOpenNotional.add(closedPositionNotional);
        }

        _accountMarketMap.addOpenNotionalFraction(
            params.trader,
            params.baseToken,
            realizedPnl.sub(deltaAvailableQuote)
        );
        _realizePnl(params.trader, realizedPnl);
        response.openNotional = getOpenNotional(params.trader, params.baseToken);
        response.realizedPnl = realizedPnl;

        // burn excess tokens
        _burn(params.trader, params.baseToken);
        _burn(params.trader, quoteToken);
        _deregisterBaseToken(params.trader, params.baseToken);

        return response;
    }

    // caller must ensure there's enough quote available and debt
    function _realizePnl(address account, int256 deltaPnl) internal {
        if (deltaPnl == 0) {
            return;
        }

        // TODO refactor with settle()
        _accountMap[account].owedRealizedPnl = _accountMap[account].owedRealizedPnl.add(deltaPnl);

        uint256 deltaPnlAbs = deltaPnl.abs();
        // has profit
        if (deltaPnl > 0) {
            _accountMarketMap.addAvailable(account, quoteToken, -(deltaPnlAbs.toInt256()));
            return;
        }

        // deltaPnl < 0 (has loss)
        uint256 quoteDebt = _accountMarketMap.getDebt(account, quoteToken);
        if (deltaPnlAbs > quoteDebt) {
            // increase quote.debt enough so that subtraction wil not underflow
            _mint(account, quoteToken, deltaPnlAbs.sub(quoteDebt), false);
        }
        _accountMarketMap.addDebt(account, quoteToken, -(deltaPnlAbs.toInt256()));
    }

    // check here for custom fee design,
    // https://www.notion.so/perp/Customise-fee-tier-on-B2QFee-1b7244e1db63416c8651e8fa04128cdb
    function _swap(InternalSwapParams memory params) internal returns (SwapResponse memory) {
        Exchange.SwapResponse memory response =
            Exchange(exchange).swap(
                Exchange.SwapParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    updatedGlobalFundingGrowth: params.updatedGlobalFundingGrowth
                })
            );

        // update internal states
        // examples:
        // https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events?node-id=0%3A1
        _accountMarketMap.addAvailable(params.trader, params.baseToken, response.exchangedPositionSize);
        _accountMarketMap.addAvailable(
            params.trader,
            quoteToken,
            response.exchangedPositionNotional.sub(response.fee.toInt256())
        );
        _accountMap[insuranceFund].owedRealizedPnl = _accountMap[insuranceFund].owedRealizedPnl.add(
            response.insuranceFundFee.toInt256()
        );

        // update timestamp of the first tx in this market
        if (_firstTradedTimestampMap[params.baseToken] == 0) {
            _firstTradedTimestampMap[params.baseToken] = _blockTimestamp();
        }

        return
            SwapResponse({
                deltaAvailableBase: response.exchangedPositionSize.abs(),
                deltaAvailableQuote: response.exchangedPositionNotional.sub(response.fee.toInt256()).abs(),
                exchangedPositionSize: response.exchangedPositionSize,
                exchangedPositionNotional: response.exchangedPositionNotional,
                fee: response.fee,
                openNotional: 0,
                realizedPnl: 0,
                tick: response.tick
            });
    }

    function _removeLiquidity(InternalRemoveLiquidityParams memory params)
        private
        returns (RemoveLiquidityResponse memory)
    {
        // must settle funding before getting token info
        _settleFundingAndUpdateFundingGrowth(params.maker, params.baseToken);
        Exchange.RemoveLiquidityResponse memory response =
            Exchange(exchange).removeLiquidity(
                Exchange.RemoveLiquidityParams({
                    maker: params.maker,
                    baseToken: params.baseToken,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );

        _afterRemoveLiquidity(
            AfterRemoveLiquidityParams({
                maker: params.maker,
                baseToken: params.baseToken,
                removedBase: response.base,
                removedQuote: response.quote,
                collectedFee: response.fee
            })
        );
        return RemoveLiquidityResponse({ quote: response.quote, base: response.base, fee: response.fee });
    }

    /// @dev explainer diagram for the relationship between exchangedPositionNotional, fee and openNotional:
    ///      https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events
    function _openPosition(InternalOpenPositionParams memory params) internal returns (SwapResponse memory) {
        SwapResponse memory swapResponse =
            _swapAndCalculateOpenNotional(
                InternalSwapParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    updatedGlobalFundingGrowth: params.updatedGlobalFundingGrowth
                })
            );

        // if this is the last position being closed, settle the remaining quote
        // must after burnMax(quote)
        if (_accountMap[params.trader].tokens.length == 0) {
            _realizePnl(params.trader, _accountMarketMap.getTokenBalance(params.trader, quoteToken).getNet());
        }

        if (!params.skipMarginRequirementCheck) {
            // it's not closing the position, check margin ratio
            _requireEnoughFreeCollateral(params.trader);
        }

        emit PositionChanged(
            params.trader,
            params.baseToken,
            swapResponse.exchangedPositionSize,
            swapResponse.exchangedPositionNotional,
            swapResponse.fee,
            swapResponse.openNotional,
            swapResponse.realizedPnl
        );

        return swapResponse;
    }

    function _closePosition(InternalClosePositionParams memory params) internal returns (SwapResponse memory) {
        int256 positionSize = getPositionSize(params.trader, params.baseToken);

        // CH_PSZ: position size is zero
        require(positionSize != 0, "CH_PSZ");

        // if trader is on long side, baseToQuote: true, exactInput: true
        // if trader is on short side, baseToQuote: false (quoteToBase), exactInput: false (exactOutput)
        bool isLong = positionSize > 0 ? true : false;

        Exchange.ReplaySwapParams memory replaySwapParams =
            Exchange.ReplaySwapParams({
                baseToken: params.baseToken,
                isBaseToQuote: isLong,
                isExactInput: isLong,
                amount: positionSize.abs(),
                sqrtPriceLimitX96: params.sqrtPriceLimitX96
            });

        // simulate the tx to see if it isOverPriceLimit; if true, can partially close the position only once
        if (partialCloseRatio > 0 && _isOverPriceLimitByReplaySwap(replaySwapParams)) {
            // CH_AOPLO: already over price limit once
            require(_blockTimestamp() != _lastOverPriceLimitTimestampMap[params.trader][params.baseToken], "CH_AOPLO");
            _lastOverPriceLimitTimestampMap[params.trader][params.baseToken] = _blockTimestamp();
            replaySwapParams.amount = replaySwapParams.amount.mulRatio(partialCloseRatio);
        }

        return
            _openPosition(
                InternalOpenPositionParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: replaySwapParams.isBaseToQuote,
                    isExactInput: replaySwapParams.isExactInput,
                    amount: replaySwapParams.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: true,
                    updatedGlobalFundingGrowth: params.updatedGlobalFundingGrowth
                })
            );
    }

    function _settleFundingAndUpdateFundingGrowth(address trader, address baseToken)
        private
        returns (Funding.Growth memory updatedGlobalFundingGrowth)
    {
        uint256 markTwap;
        uint256 indexTwap;
        (updatedGlobalFundingGrowth, markTwap, indexTwap) = _getUpdatedGlobalFundingGrowth(baseToken);

        int256 fundingPayment = _updateFundingGrowthAndFundingPayment(trader, baseToken, updatedGlobalFundingGrowth);

        if (fundingPayment != 0) {
            _accountMap[trader].owedRealizedPnl = _accountMap[trader].owedRealizedPnl.sub(fundingPayment);
            emit FundingPaymentSettled(trader, baseToken, fundingPayment);
        }

        // update states of the last tx before further actions in this block; once per block
        if (_lastSettledTimestampMap[baseToken] != _blockTimestamp()) {
            // update fundingGrowth
            Funding.Growth storage outdatedGlobalFundingGrowth = _globalFundingGrowthX96Map[baseToken];
            (
                _lastSettledTimestampMap[baseToken],
                outdatedGlobalFundingGrowth.twPremiumX96,
                outdatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
            ) = (
                _blockTimestamp(),
                updatedGlobalFundingGrowth.twPremiumX96,
                updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
            );

            // update tick
            _lastUpdatedTickMap[baseToken] = Exchange(exchange).getTick(baseToken);

            emit FundingUpdated(baseToken, markTwap, indexTwap);
        }
    }

    /// @dev this is the non-view version of _getPendingFundingPayment()
    function _updateFundingGrowthAndFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory updatedGlobalFundingGrowth
    ) internal returns (int256) {
        int256 liquidityCoefficientInFundingPayment =
            Exchange(exchange).updateFundingGrowthAndLiquidityCoefficientInFundingPayment(
                trader,
                baseToken,
                updatedGlobalFundingGrowth
            );
        int256 fundingPayment =
            _accountMarketMap[trader][baseToken].updateLastFundingGrowth(
                liquidityCoefficientInFundingPayment,
                updatedGlobalFundingGrowth.twPremiumX96
            );
        return fundingPayment;
    }

    function _isOverPriceLimitByReplaySwap(Exchange.ReplaySwapParams memory params) internal returns (bool) {
        uint24 maxTickDelta = _maxTickCrossedWithinBlockMap[params.baseToken];
        if (maxTickDelta == 0) {
            return false;
        }

        int24 finalTick = Exchange(exchange).replaySwap(params);
        return _isOverPriceLimit(params.baseToken, maxTickDelta, finalTick);
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //

    function _isOverPriceLimit(
        address baseToken,
        uint24 maxTickDelta,
        int24 tick
    ) internal view returns (bool) {
        if (maxTickDelta == 0) {
            return false;
        }
        int24 lastUpdatedTick = _lastUpdatedTickMap[baseToken];
        // no overflow/underflow issue because there are range limits for tick and maxTickDelta
        int24 upperTickBound = lastUpdatedTick + int24(maxTickDelta);
        int24 lowerTickBound = lastUpdatedTick - int24(maxTickDelta);
        return (tick < lowerTickBound || tick > upperTickBound);
    }

    // -------------------------------
    // --- funding related getters ---

    /// @dev this is the view version of _updateFundingGrowthAndFundingPayment()
    function _getPendingFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory updatedGlobalFundingGrowth
    ) internal view returns (int256 fundingPayment) {
        int256 liquidityCoefficientInFundingPayment =
            Exchange(exchange).getLiquidityCoefficientInFundingPayment(trader, baseToken, updatedGlobalFundingGrowth);

        // funding of liquidity
        return
            _accountMarketMap.getPendingFundingPayment(
                trader,
                baseToken,
                liquidityCoefficientInFundingPayment,
                updatedGlobalFundingGrowth.twPremiumX96
            );
    }

    function _getAllPendingFundingPayment(address trader) internal view returns (int256 fundingPayment) {
        for (uint256 i = 0; i < _accountMap[trader].tokens.length; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            if (_hasPool(baseToken)) {
                fundingPayment = fundingPayment.add(getPendingFundingPayment(trader, baseToken));
            }
        }
    }

    function _getUpdatedGlobalFundingGrowth(address baseToken)
        internal
        view
        returns (
            Funding.Growth memory updatedGlobalFundingGrowth,
            uint256 markTwap,
            uint256 indexTwap
        )
    {
        Funding.Growth storage outdatedGlobalFundingGrowth = _globalFundingGrowthX96Map[baseToken];

        // get mark twap
        uint32 twapIntervalArg = twapInterval;
        // shorten twapInterval if prior observations are not enough for twapInterval
        if (_firstTradedTimestampMap[baseToken] == 0) {
            twapIntervalArg = 0;
        } else if (twapIntervalArg > _blockTimestamp().sub(_firstTradedTimestampMap[baseToken])) {
            // overflow inspection:
            // 2 ^ 32 = 4,294,967,296 > 100 years = 60 * 60 * 24 * 365 * 100 = 3,153,600,000
            twapIntervalArg = uint32(_blockTimestamp().sub(_firstTradedTimestampMap[baseToken]));
        }

        uint256 markTwapX96 =
            Exchange(exchange).getSqrtMarkTwapX96(baseToken, twapIntervalArg).formatSqrtPriceX96ToPriceX96();
        markTwap = markTwapX96.formatX96ToX10_18();
        indexTwap = _getIndexPrice(baseToken);

        uint256 lastSettledTimestamp = _lastSettledTimestampMap[baseToken];
        if (lastSettledTimestamp != _blockTimestamp() && lastSettledTimestamp != 0) {
            int256 twPremiumDeltaX96 =
                markTwapX96.toInt256().sub(indexTwap.formatX10_18ToX96().toInt256()).mul(
                    _blockTimestamp().sub(lastSettledTimestamp).toInt256()
                );
            updatedGlobalFundingGrowth.twPremiumX96 = outdatedGlobalFundingGrowth.twPremiumX96.add(twPremiumDeltaX96);

            // overflow inspection:
            // assuming premium = 1 billion (1e9), time diff = 1 year (3600 * 24 * 365)
            // log(1e9 * 2^96 * (3600 * 24 * 365) * 2^96) / log(2) = 246.8078491997 < 255
            updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96 = outdatedGlobalFundingGrowth
                .twPremiumDivBySqrtPriceX96
                .add(
                (twPremiumDeltaX96.mul(PerpFixedPoint96.IQ96)).div(
                    uint256(Exchange(exchange).getSqrtMarkTwapX96(baseToken, 0)).toInt256()
                )
            );
        } else {
            // if this is the latest updated block, values in _globalFundingGrowthX96Map are up-to-date already
            updatedGlobalFundingGrowth = outdatedGlobalFundingGrowth;
        }
    }

    // --- funding related getters ---
    // -------------------------------

    function _getIndexPrice(address token) internal view returns (uint256) {
        return IIndexPrice(token).getIndexPrice(twapInterval);
    }

    // return decimals 18
    function _getTotalInitialMarginRequirement(address trader) internal view returns (uint256) {
        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = _accountMarketMap.getDebt(trader, quoteToken);
        uint256 totalPositionValue = _getTotalAbsPositionValue(trader);
        uint256 totalBaseDebtValue = _getTotalBaseDebtValue(trader);
        return Math.max(totalPositionValue, totalBaseDebtValue.add(quoteDebtValue)).mulRatio(imRatio);
    }

    // return in settlement token decimals
    function _getTotalCollateralValue(address trader) internal view returns (int256) {
        int256 owedRealizedPnl = _accountMap[trader].owedRealizedPnl.sub(_getAllPendingFundingPayment(trader));
        return IVault(vault).balanceOf(trader).addS(owedRealizedPnl, _settlementTokenDecimals);
    }

    /// @dev we use 15 mins twap to calc position value
    function _getPositionValue(address trader, address token) internal view returns (int256) {
        int256 positionSize = _getPositionSize(trader, token);
        if (positionSize == 0) return 0;

        uint256 indexTwap = IIndexPrice(token).getIndexPrice(twapInterval);

        // both positionSize & indexTwap are in 10^18 already
        return positionSize.mul(indexTwap.toInt256()).divBy10_18();
    }

    // TODO refactor with _getTotalBaseDebtValue and getTotalUnrealizedPnl
    function _getTotalAbsPositionValue(address trader) internal view returns (uint256) {
        address[] memory tokens = _accountMap[trader].tokens;
        uint256 totalPositionValue;
        uint256 tokenLen = tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = tokens[i];
            if (_hasPool(baseToken)) {
                // will not use negative value in this case
                uint256 positionValue = _getPositionValue(trader, baseToken).abs();
                totalPositionValue = totalPositionValue.add(positionValue);
            }
        }
        return totalPositionValue;
    }

    function _getTotalBaseDebtValue(address trader) internal view returns (uint256) {
        Account storage account = _accountMap[trader];
        uint256 totalBaseDebtValue;
        uint256 tokenLen = account.tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = account.tokens[i];
            if (_hasPool(baseToken)) {
                uint256 baseDebtValue =
                    _accountMarketMap.getDebt(trader, baseToken).mul(_getIndexPrice(baseToken)).divBy10_18();
                totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
            }
        }
        return totalBaseDebtValue;
    }

    function _getPositionSize(address trader, address baseToken) internal view returns (int256) {
        uint256 vBaseAmount =
            _accountMarketMap.getAvailable(trader, baseToken).add(
                Exchange(exchange).getTotalTokenAmountInPool(
                    trader,
                    baseToken,
                    true // get base token amount
                )
            );

        // NOTE: when a token goes into UniswapV3 pool (addLiquidity or swap), there would be 1 wei rounding error
        // for instance, maker adds liquidity with 2 base (2000000000000000000),
        // the actual base amount in pool would be 1999999999999999999
        int256 positionSize = vBaseAmount.toInt256().sub(_accountMarketMap.getDebt(trader, baseToken).toInt256());
        return positionSize.abs() < _DUST ? 0 : positionSize;
    }

    function _hasPool(address baseToken) internal view returns (bool) {
        return Exchange(exchange).getPool(baseToken) != address(0);
    }

    function _isIncreasePosition(
        address trader,
        address baseToken,
        bool isBaseToQuote
    ) internal view returns (bool) {
        // increase position == old/new position are in the same direction
        int256 positionSize = getPositionSize(trader, baseToken);
        bool isOldPositionShort = positionSize < 0 ? true : false;
        return (positionSize == 0 || isOldPositionShort == isBaseToQuote);
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgSender() internal view override(BaseRelayRecipient, Context) returns (address payable) {
        return super._msgSender();
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, Context) returns (bytes memory) {
        return super._msgData();
    }

    function _requireHasBaseToken(address baseToken) internal view {
        // CH_BTNE: base token not exists
        require(_hasPool(baseToken), "CH_BTNE");
    }

    // there are three configurations for different insolvency risk tolerance: conservative, moderate, aggressive
    // we will start with the conservative one, then gradually change it to more aggressive ones
    // to increase capital efficiency.
    function _getFreeCollateral(address trader) private view returns (int256) {
        // conservative config: freeCollateral = max(min(collateral, accountValue) - imReq, 0)
        int256 totalCollateralValue = _getTotalCollateralValue(trader);
        int256 accountValue = totalCollateralValue.addS(getTotalUnrealizedPnl(trader), _settlementTokenDecimals);
        uint256 totalInitialMarginRequirement = _getTotalInitialMarginRequirement(trader);
        int256 freeCollateral =
            PerpMath.min(totalCollateralValue, accountValue).subS(
                totalInitialMarginRequirement.toInt256(),
                _settlementTokenDecimals
            );

        return freeCollateral;

        // TODO checklist before enabling more aggressive configs:
        // - protect the system against index price spread attack
        //   https://www.notion.so/perp/Index-price-spread-attack-2f203d45b34f4cc3ab80ac835247030f
        // - protect against index price anomaly (see the TODO for aggressive model below)

        // moderate config: freeCollateral = max(min(collateral, accountValue - imReq), 0)
        // return PerpMath.max(PerpMath.min(collateralValue, accountValue.subS(totalImReq, decimals)), 0).toUint256();

        // aggressive config: freeCollateral = max(accountValue - imReq, 0)
        // TODO note that aggressive model depends entirely on unrealizedPnl, which depends on the index price, for
        //  calculating freeCollateral. We should implement some sort of safety check before using this model;
        //  otherwise a trader could drain the entire vault if the index price deviates significantly.
        // return PerpMath.max(accountValue.subS(totalImReq, decimals), 0).toUint256()
    }

    function _requireEnoughFreeCollateral(address trader) internal view {
        // CH_NEAV: not enough account value
        require(_getFreeCollateral(trader) >= 0, "CH_NEAV");
    }

    function _checkSlippage(CheckSlippageParams memory params) internal pure {
        // skip when params.oppositeAmountBound is zero
        if (params.oppositeAmountBound == 0) {
            return;
        }

        // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
        // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
        // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
        // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
        if (params.isBaseToQuote) {
            if (params.isExactInput) {
                // too little received
                require(params.deltaAvailableQuote >= params.oppositeAmountBound, "CH_TLR");
            } else {
                // too much requested
                require(params.deltaAvailableBase <= params.oppositeAmountBound, "CH_TMR");
            }
        } else {
            if (params.isExactInput) {
                // too little received
                require(params.deltaAvailableBase >= params.oppositeAmountBound, "CH_TLR");
            } else {
                // too much requested
                require(params.deltaAvailableQuote <= params.oppositeAmountBound, "CH_TMR");
            }
        }
    }
}
