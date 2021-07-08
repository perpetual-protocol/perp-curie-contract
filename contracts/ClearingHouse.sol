pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { FixedPoint128 } from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { IMintableERC20 } from "./interface/IMintableERC20.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";

// TODO change to ERC20Metadata for decimals
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "hardhat/console.sol";

contract ClearingHouse is IUniswapV3MintCallback, IUniswapV3SwapCallback, ReentrancyGuard, Context, Ownable {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SafeCast for uint128;
    using SignedSafeMath for int256;
    using SafeCast for int256;

    //
    // events
    //
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);
    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Minted(address indexed token, uint256 amount);
    event Burned(address indexed token, uint256 amount);
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
        uint256 baseFee, // amount of base token the maker received as fee
        uint256 quoteFee // amount of quote token the maker received as fee
    );
    event FundingRateUpdated(int256 rate, uint256 underlyingPrice);

    //
    // Struct
    //

    struct Account {
        uint256 collateral;
        address[] tokens; // all tokens (incl. quote and base) this account is in debt of
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => TokenInfo) tokenInfoMap; // balance & debt info of each token
        // @audit - suggest to flatten the mapping by keep an orderIds[] here
        // and create another _openOrderMap global state
        // because the orderId already contains the baseTokenAddr (@wraecca).
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => MakerPosition) makerPositionMap; // open orders for maker
    }

    struct TokenInfo {
        uint256 available; // amount available in CH
        uint256 debt;
    }

    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideBaseX128;
        uint256 feeGrowthInsideQuoteX128;
    }

    struct MakerPosition {
        bytes32[] orderIds;
        // key: order id
        mapping(bytes32 => OpenOrder) openOrderMap;
    }

    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
    }

    /// @param liquidity collect fee when 0
    struct RemoveLiquidityParams {
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct SwapParams {
        address baseToken;
        // @audit - this is not required (@wraecca)
        address quoteToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    //
    // state variables
    //
    uint256 public imRatio = 0.1 ether; // initial-margin ratio, 10%
    uint256 public mmRatio = 0.0625 ether; // minimum-margin ratio, 6.25%

    address public immutable collateralToken;
    address public immutable quoteToken;
    address public immutable uniswapV3Factory;

    // key: base token, value: pool
    mapping(address => address) private _poolMap;

    // key: trader
    mapping(address => Account) private _accountMap;

    uint256 public immutable fundingPeriod;

    mapping(address => uint256) private _nextFundingTimeMap;
    mapping(address => int256[]) private _premiumFractionsMap;
    mapping(address => uint256[]) private _sqrtMarkTwapPricesX96Map;

    constructor(
        address collateralTokenArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        uint256 fundingPeriodArg
    ) {
        require(collateralTokenArg != address(0), "CH_II_C");
        require(quoteTokenArg != address(0), "CH_II_Q");
        require(uniV3FactoryArg != address(0), "CH_II_U");

        collateralToken = collateralTokenArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
        fundingPeriod = fundingPeriodArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function addPool(address baseToken, uint24 feeRatio) external onlyOwner {
        // to ensure the base is always token0 and quote is always token1
        // CH_IB: invalid baseToken
        require(baseToken < quoteToken, "CH_IB");
        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // CH_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "CH_NEP");
        // CH_EP: existent pool in ClearingHouse
        require(pool != _poolMap[baseToken], "CH_EP");

        _poolMap[baseToken] = pool;
        emit PoolAdded(baseToken, feeRatio, pool);
    }

    // TODO should add modifier: whenNotPaused()
    function deposit(uint256 amount) external nonReentrant() {
        address trader = _msgSender();
        Account storage account = _accountMap[trader];
        account.collateral = account.collateral.add(amount);
        TransferHelper.safeTransferFrom(collateralToken, trader, address(this), amount);

        emit Deposited(collateralToken, trader, amount);
    }

    /**
     * @param amount the amount of debt to burn
     */
    function burn(address token, uint256 amount) public nonReentrant() {
        _requireTokenExistAndValidAmount(token, amount);

        // update internal states
        address trader = _msgSender();
        TokenInfo storage tokenInfo = _accountMap[trader].tokenInfoMap[token];

        // CH_IA: invalid amount
        // can only burn the amount of debt that can be pay back with available
        console.log("tokenInfo.debt,=%s", tokenInfo.debt);
        console.log("tokenInfo.available,=%s", tokenInfo.available);
        require(amount <= Math.min(tokenInfo.debt, tokenInfo.available), "CH_IA");

        // TODO: move to closePosition
        // bool isQuote = token == quoteToken;
        // if (amount > tokenInfo.debt) {
        //     uint256 realizedProfit = amount - tokenInfo.debt;
        //     // amount = amount - realizedProfit
        //     amount = tokenInfo.debt;
        //     if (isQuote) {
        //         tokenInfo.available = tokenInfo.available.sub(realizedProfit);
        //         _accountMap[trader].collateral = _accountMap[trader].collateral.add(realizedProfit);
        //     } else {
        //         // TODO how to do slippage protection
        //         // realize base profit as quote
        //         swap(SwapParams(token, quoteToken, true, false, realizedProfit, 0));
        //     }
        // }

        // pay back debt
        tokenInfo.available = tokenInfo.available.sub(amount);
        tokenInfo.debt = tokenInfo.debt.sub(amount);

        IMintableERC20(token).burn(amount);

        emit Burned(token, amount);
    }

    function swap(SwapParams memory params)
        public
        nonReentrant()
        returns (UniswapV3Broker.SwapResponse memory response)
    {
        IUniswapV3Pool pool = IUniswapV3Pool(getPool(params.baseToken));
        response = UniswapV3Broker.swap(
            UniswapV3Broker.SwapParams(
                pool,
                params.baseToken,
                params.quoteToken,
                params.isBaseToQuote,
                params.isExactInput,
                params.amount,
                params.sqrtPriceLimitX96
            )
        );

        // update internal states
        address trader = _msgSender();
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[params.quoteToken];

        if (params.isBaseToQuote) {
            baseTokenInfo.available = baseTokenInfo.available.sub(response.base);
            quoteTokenInfo.available = quoteTokenInfo.available.add(response.quote);
        } else {
            quoteTokenInfo.available = quoteTokenInfo.available.sub(response.quote);
            baseTokenInfo.available = baseTokenInfo.available.add(response.base);
        }
    }

    // TODO should add modifier: whenNotPaused()
    function mint(address token, uint256 amount) external nonReentrant() {
        _mint(token, amount, true);
    }

    function _mint(
        address token,
        uint256 amount,
        bool checkMarginRatio
    ) private returns (uint256) {
        _requireTokenExistAndValidAmount(token, amount);

        IMintableERC20(token).mint(address(this), amount);

        // update internal states
        address trader = _msgSender();
        TokenInfo storage tokenInfo = _accountMap[trader].tokenInfoMap[token];
        tokenInfo.available = tokenInfo.available.add(amount);
        tokenInfo.debt = tokenInfo.debt.add(amount);

        _registerToken(trader, token);

        if (checkMarginRatio) {
            // TODO: optimize when mint both
            // CH_NEAV: not enough account value
            require(getAccountValue(trader) >= _getTotalInitialMarginRequirement(trader).toInt256(), "CH_NEAV");
        }

        emit Minted(token, amount);
        return amount;
    }

    // ensure token is base or quote
    function _mintMax(address token) private returns (uint256) {
        uint256 freeCollateral = getFreeCollateral(_msgSender());
        console.log("freecOLL: %s", freeCollateral);
        if (freeCollateral == 0) {
            return 0;
        }

        // normalize free collateral from collateral decimals to quote decimals
        uint256 collateralDecimals = ERC20(collateralToken).decimals();
        uint256 quoteDecimals = ERC20(quoteToken).decimals();
        console.log("collateralDecimals: %s", collateralDecimals);
        console.log("quoteDecimals: %s", quoteDecimals);
        uint256 normalizedFreeCollateral = FullMath.mulDiv(freeCollateral, 10**quoteDecimals, 10**collateralDecimals);
        uint256 mintableQuote = FullMath.mulDiv(normalizedFreeCollateral, 1 ether, imRatio);
        console.log("mintableQuote: %s", mintableQuote);

        uint256 minted;
        if (token == quoteToken) {
            minted = mintableQuote;
        } else {
            // TODO: change the valuation method && align with baseDebt()
            mintableQuote = mintableQuote.div(getIndexPrice(token));
        }
        return _mint(token, minted, false);
    }

    function addLiquidity(AddLiquidityParams calldata params) external nonReentrant() {
        address trader = _msgSender();
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        uint256 baseAvailable = baseTokenInfo.available;
        uint256 quoteAvailable = quoteTokenInfo.available;
        // CH_NEB: not enough available base amount
        require(baseAvailable >= params.base, "CH_NEB");
        // CH_NEB: not enough available quote amount
        require(quoteAvailable >= params.quote, "CH_NEQ");

        // add liquidity to liquidity pool
        UniswapV3Broker.AddLiquidityResponse memory response =
            UniswapV3Broker.addLiquidity(
                UniswapV3Broker.AddLiquidityParams(
                    _poolMap[params.baseToken],
                    params.baseToken,
                    quoteToken,
                    params.lowerTick,
                    params.upperTick,
                    params.base,
                    params.quote
                )
            );
        // mint callback
        // TODO add slippage protection

        // load existing open order
        bytes32 orderId = _getOrderId(trader, params.baseToken, params.lowerTick, params.upperTick);
        MakerPosition storage makerPosition = _accountMap[trader].makerPositionMap[params.baseToken];
        OpenOrder storage openOrder = _accountMap[trader].makerPositionMap[params.baseToken].openOrderMap[orderId];

        uint256 baseFee;
        uint256 quoteFee;
        if (openOrder.liquidity == 0) {
            // it's a new order
            makerPosition.orderIds.push(orderId);
            openOrder.lowerTick = params.lowerTick;
            openOrder.upperTick = params.upperTick;
        } else {
            baseFee = _calcOwedFee(
                openOrder.liquidity,
                response.feeGrowthInsideBaseX128,
                openOrder.feeGrowthInsideBaseX128
            );
            quoteFee = _calcOwedFee(
                openOrder.liquidity,
                response.feeGrowthInsideQuoteX128,
                openOrder.feeGrowthInsideQuoteX128
            );
        }

        // update token info
        baseTokenInfo.available = baseAvailable.add(baseFee).sub(response.base);
        quoteTokenInfo.available = quoteAvailable.add(quoteFee).sub(response.quote);

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().add(response.liquidity.toUint256()).toUint128();
        openOrder.feeGrowthInsideBaseX128 = response.feeGrowthInsideBaseX128;
        openOrder.feeGrowthInsideQuoteX128 = response.feeGrowthInsideQuoteX128;

        _emitLiquidityChanged(trader, params, response, baseFee, quoteFee);
    }

    function removeLiquidity(RemoveLiquidityParams calldata params) external nonReentrant() {
        // load existing open order
        address trader = _msgSender();
        bytes32 orderId = _getOrderId(trader, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _accountMap[trader].makerPositionMap[params.baseToken].openOrderMap[orderId];
        // CH_ZL non-existent openOrder
        require(openOrder.liquidity > 0, "CH_NEO");
        // CH_NEL not enough liquidity
        require(params.liquidity <= openOrder.liquidity, "CH_NEL");

        UniswapV3Broker.RemoveLiquidityResponse memory response =
            UniswapV3Broker.removeLiquidity(
                UniswapV3Broker.RemoveLiquidityParams(
                    _poolMap[params.baseToken],
                    params.lowerTick,
                    params.upperTick,
                    params.liquidity
                )
            );

        // TODO add slippage protection

        // update token info based on existing open order
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        uint256 baseFee =
            _calcOwedFee(openOrder.liquidity, response.feeGrowthInsideBaseX128, openOrder.feeGrowthInsideBaseX128);
        uint256 quoteFee =
            _calcOwedFee(openOrder.liquidity, response.feeGrowthInsideQuoteX128, openOrder.feeGrowthInsideQuoteX128);
        baseTokenInfo.available = baseTokenInfo.available.add(baseFee).add(response.base);
        quoteTokenInfo.available = quoteTokenInfo.available.add(quoteFee).add(response.quote);

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().sub(params.liquidity.toUint256()).toUint128();
        if (openOrder.liquidity == 0) {
            _removeOrder(trader, params.baseToken, orderId);
        } else {
            openOrder.feeGrowthInsideBaseX128 = response.feeGrowthInsideBaseX128;
            openOrder.feeGrowthInsideQuoteX128 = response.feeGrowthInsideQuoteX128;
        }

        _emitLiquidityChanged(trader, params, response, baseFee, quoteFee);
    }

    function openPosition(OpenPositionParams memory params) external {
        uint256 baseAvailableBefore = getTokenInfo(_msgSender(), params.baseToken).available;
        uint256 quoteAvailableBefore = getTokenInfo(_msgSender(), quoteToken).available;
        uint256 minted;
        console.log("baseAvailableBefore=%s", baseAvailableBefore);
        console.log("quoteAvailableBefore=%s", quoteAvailableBefore);

        // calculate if we need to mint more quote or base
        if (params.isExactInput) {
            if (params.isBaseToQuote) {
                // check if taker has enough base to swap
                if (baseAvailableBefore < params.amount) {
                    minted = _mint(params.baseToken, params.amount.sub(baseAvailableBefore), true);
                }
            } else {
                // check if taker has enough quote to swap
                if (quoteAvailableBefore < params.amount) {
                    minted = _mint(quoteToken, params.amount.sub(quoteAvailableBefore), true);
                }
            }
        } else {
            // is exact output
            if (params.isBaseToQuote) {
                // taker want to get exact quote from base
                minted = _mintMax(params.baseToken);
            } else {
                // taker want to get exact base from quote
                minted = _mintMax(quoteToken);
            }
        }

        UniswapV3Broker.SwapResponse memory swapResponse =
            swap(
                SwapParams({
                    baseToken: params.baseToken,
                    quoteToken: quoteToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96
                })
            );

        // before = 0, mint max + 10000
        // swap 1 eth need 1000 (assume we have quoter, mint 1000)
        // quote 9000
        // burn 9000 = actual mint (10000) - extra required mint (1000)
        // extra mint (1000) = max((swapped (1000) - before (0)), 0)

        // burn extra minted
        // before = 100, mint max +9900, total 10000
        // swap 1 ETH need 1000 (assume quoter, mint 900)
        // quote = 9000
        // burn 9000 = actual mint (9900) - extra required mint (900)
        // extra mint (900) = max((swapped (1000) - before (100)), 0)

        // before = 7000
        // mint amx = 10000
        // swap 1ETH need 1000 (assume quoter, mint 0)
        // quote = 9000
        // expect to be 6000
        // burn 3000 = actual mint (3000) - extra required mint (0)
        // extra mint (0) = max((swapped (1000) - before (7000), 0)

        if (params.isBaseToQuote) {
            uint256 exactInsufficientBase;
            if (swapResponse.base > baseAvailableBefore) {
                exactInsufficientBase = swapResponse.base.sub(baseAvailableBefore);
            }

            console.log("exactInsufficientBase= %s", exactInsufficientBase);
            if (minted > exactInsufficientBase) {
                console.log("minted.sub(exactInsufficientBase)= %s", minted.sub(exactInsufficientBase));
                burn(params.baseToken, minted.sub(exactInsufficientBase));
            }
        } else {
            uint256 exactInsufficientQuote;
            if (swapResponse.quote > quoteAvailableBefore) {
                exactInsufficientQuote = swapResponse.quote.sub(quoteAvailableBefore);
            }

            console.log("exactInsufficientQuote= %s", exactInsufficientQuote);
            if (minted > exactInsufficientQuote) {
                console.log("minted.sub(exactInsufficientQuote)= %s", minted.sub(exactInsufficientQuote));
                burn(quoteToken, minted.sub(exactInsufficientQuote));
            }
        }

        // chekc margin ratio if its not close position
        // if (isPositionClosed()) {
        //     _settle(msgSender());
        // } else {
        //     requiredInitMarginRequirement();
        // }
    }

    // @audit: review security and possible attacks (@detoo)
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

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_ZIs: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        address baseToken = abi.decode(data, (address));
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[baseToken]);
        // CH_FSV: failed swapCallback verification
        require(_msgSender() == address(pool), "CH_FSV");

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0 ? (pool.token0(), uint256(amount0Delta)) : (pool.token1(), uint256(amount1Delta));
        // swap fail
        TransferHelper.safeTransfer(token, _msgSender(), amountToPay);
    }

    /**
     * @notice "pay funding" by registering the primitives for funding calculations (premiumFraction, markPrice, etc)
     * so that we can defer the actual settlement of payment later for each market and each trader, respectively,
     * therefore spread out the computational loads. It is expected to be called by a keeper every fundingPeriod.
     * @param baseToken base token address
     */
    function updateFunding(address baseToken) external {
        // TODO should check if market is open

        // solhint-disable-next-line not-rely-on-time
        uint256 nowTimestamp = block.timestamp;
        // CH_UFTE update funding too early
        require(nowTimestamp >= _nextFundingTimeMap[baseToken], "CH_UFTE");

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        uint256 sqrtMarkTwapPriceX96 = uint256(getSqrtMarkTwapPrice(baseToken, fundingPeriod));
        uint256 markTwapPriceX96 = FullMath.mulDiv(sqrtMarkTwapPriceX96, sqrtMarkTwapPriceX96, FixedPoint96.Q96);
        uint256 markTwapPriceIn18Digit = FullMath.mulDiv(markTwapPriceX96, 1 ether, FixedPoint96.Q96);
        uint256 indexTwapPrice = getIndexTwapPrice(baseToken, fundingPeriod);

        int256 premium = markTwapPriceIn18Digit.toInt256().sub(indexTwapPrice.toInt256());
        int256 premiumFraction = premium.mul(fundingPeriod.toInt256()).div(int256(1 days));

        // register primitives for funding calculations so we can settle it later
        _premiumFractionsMap[baseToken].push(premiumFraction);
        _sqrtMarkTwapPricesX96Map[baseToken].push(sqrtMarkTwapPriceX96);

        // update next funding time requirements so we can prevent multiple funding settlement
        // during very short time after network congestion
        uint256 minNextValidFundingTime = nowTimestamp.add(fundingPeriod.div(2));
        // (floor(nowTimestamp / fundingPeriod) + 1) * fundingPeriod
        uint256 nextFundingTimeOnHourStart = nowTimestamp.div(fundingPeriod).add(1).mul(fundingPeriod);
        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        _nextFundingTimeMap[baseToken] = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;

        emit FundingRateUpdated(premiumFraction.mul(1 ether).div(indexTwapPrice.toInt256()), indexTwapPrice);
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getPool(address baseToken) public view returns (address poolAddress) {
        poolAddress = _poolMap[baseToken];
        // pool not found
        require(poolAddress != address(0), "CH_PNF");
    }

    function getCollateral(address trader) external view returns (uint256) {
        return _accountMap[trader].collateral;
    }

    function getAccountValue(address trader) public view returns (int256) {
        return _accountMap[trader].collateral.toInt256().add(_getTotalMarketPnl(trader));
    }

    function getAccountTokens(address trader) public view returns (address[] memory) {
        return _accountMap[trader].tokens;
    }

    function getFreeCollateral(address trader) public view returns (uint256) {
        int256 freeCollateral = getAccountValue(trader).sub(_getTotalInitialMarginRequirement(trader).toInt256());
        return freeCollateral > 0 ? freeCollateral.toUint256() : 0;
    }

    function getIndexPrice(address token) public view returns (uint256) {
        // TODO WIP
        return 100 ether;
    }

    function getIndexTwapPrice(address token, uint256 twapInterval) public view returns (uint256) {
        return 100 ether;
    }

    function getTokenInfo(address trader, address token) public view returns (TokenInfo memory) {
        return _accountMap[trader].tokenInfoMap[token];
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

    function getSqrtMarkTwapPrice(address baseToken, uint256 twapInterval) public view returns (uint160) {
        uint32[] memory secondsAgos = new uint32[](2);

        // solhint-disable-next-line not-rely-on-time
        secondsAgos[0] = uint32(twapInterval);
        secondsAgos[1] = uint32(0);
        (int56[] memory tickCumulatives, ) = IUniswapV3Pool(_poolMap[baseToken]).observe(secondsAgos);

        // note this assumes token0 is always the base token
        return TickMath.getSqrtRatioAtTick(int24((tickCumulatives[1] - tickCumulatives[0]) / uint32(twapInterval)));
    }

    function getNextFundingTime(address baseToken) external view returns (uint256) {
        return _nextFundingTimeMap[baseToken];
    }

    function getPremiumFraction(address baseToken, uint256 idx) external view returns (int256) {
        return _premiumFractionsMap[baseToken][idx];
    }

    function getPremiumFractionsLength(address baseToken) external view returns (uint256) {
        return _premiumFractionsMap[baseToken].length;
    }

    function getSqrtMarkTwapPriceX96(address baseToken, uint256 idx) external view returns (uint256) {
        return _sqrtMarkTwapPricesX96Map[baseToken][idx];
    }

    function getSqrtMarkTwapPricesX96Length(address baseToken) external view returns (uint256) {
        return _sqrtMarkTwapPricesX96Map[baseToken].length;
    }

    //
    // INTERNAL FUNCTIONS
    //
    function _registerToken(address trader, address token) private {
        address[] memory tokens = _accountMap[trader].tokens;
        if (tokens.length == 0) {
            _accountMap[trader].tokens.push(token);
        } else {
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

    //
    // INTERNAL VIEW FUNCTIONS
    //
    function _getTotalMarketPnl(address trader) internal pure returns (int256) {
        return 0; // TODO WIP
    }

    function _getTotalInitialMarginRequirement(address trader) internal view returns (uint256) {
        Account storage account = _accountMap[trader];

        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = account.tokenInfoMap[quoteToken].debt;
        uint256 totalPositionValue;
        uint256 totalBaseDebtValue;
        uint256 tokenLen = account.tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = account.tokens[i];
            if (_isPoolExistent(baseToken)) {
                uint256 baseDebtValue = _getDebtValue(baseToken, account.tokenInfoMap[baseToken].debt);
                uint256 positionValue = _getPositionValue(account, baseToken);
                totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
                totalPositionValue = totalPositionValue.add(positionValue);
            }
        }

        return Math.max(totalPositionValue, Math.max(totalBaseDebtValue, quoteDebtValue)).mul(imRatio).div(1 ether);
    }

    function _getDebtValue(address token, uint256 amount) private view returns (uint256) {
        return amount.mul(getIndexPrice(token)).div(1 ether);
    }

    function _getPositionValue(Account storage account, address baseToken) private view returns (uint256) {
        // TODO WIP
        // uint256 positionSize = _getPositionSize(account, baseToken);
        // simulate trade and calculate position value
        // positionValue = getExactBastToQuote(pool, 1)
        return 0;
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
        return FullMath.mulDiv(feeGrowthInsideNew.sub(feeGrowthInsideOld), liquidity, FixedPoint128.Q128);
    }

    function _emitLiquidityChanged(
        address maker,
        AddLiquidityParams memory params,
        UniswapV3Broker.AddLiquidityResponse memory response,
        uint256 baseFee,
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
            baseFee,
            quoteFee
        );
    }

    function _emitLiquidityChanged(
        address maker,
        RemoveLiquidityParams memory params,
        UniswapV3Broker.RemoveLiquidityResponse memory response,
        uint256 baseFee,
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
            baseFee,
            quoteFee
        );
    }

    function _requireTokenExistAndValidAmount(address token, uint256 amount) private view {
        if (quoteToken != token) {
            // CH_TNF: token not found
            require(_isPoolExistent(token), "CH_TNF");
        }
        // CH_IA: invalid amount
        require(amount > 0, "CH_IA");
    }
}
