pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../priceFeed/TestPriceFeed.sol";
import "../../../contracts/MarketRegistry.sol";
import "../../../contracts/ClearingHouse.sol";
import "../../../contracts/QuoteToken.sol";
import "../../../contracts/BaseToken.sol";
import "../../../contracts/VirtualToken.sol";
import "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";
import "@uniswap/v3-core/contracts/UniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3PoolDeployer.sol";
import "@uniswap/v3-core/contracts/UniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

contract MarketRegistry_spec is Test {
    string constant BASE_TOKEN_NAME = "vETH";
    string constant QUOTE_TOKEN_NAME = "vUSD";
    uint24 constant POOL_FEE = 3000;
    MarketRegistry marketRegistry;
    ClearingHouse clearingHouse;
    UniswapV3Factory uniswapV3Factory;
    UniswapV3Pool uniswapV3Pool;
    BaseToken baseToken;
    QuoteToken quoteToken;

    function createQuoteToken() internal returns (QuoteToken) {
        QuoteToken quoteToken = new QuoteToken();
        quoteToken.initialize(QUOTE_TOKEN_NAME, QUOTE_TOKEN_NAME);
        vm.mockCall(address(quoteToken), abi.encodeWithSelector(ERC20Upgradeable.decimals.selector), abi.encode(18));
        vm.mockCall(
            address(quoteToken),
            abi.encodeWithSelector(ERC20Upgradeable.totalSupply.selector),
            abi.encode(type(uint256).max)
        );
        vm.mockCall(address(quoteToken), abi.encodeWithSelector(VirtualToken.isInWhitelist.selector), abi.encode(true));
        return quoteToken;
    }

    function createBaseToken(address quoteToken, address clearingHouse) internal returns (BaseToken) {
        BaseToken baseToken;
        while (address(baseToken) == address(0) || quoteToken < address(baseToken)) {
            baseToken = new BaseToken();
        }
        TestPriceFeed priceFeed = new TestPriceFeed();

        vm.mockCall(address(priceFeed), abi.encodeWithSelector(IPriceFeed.decimals.selector), abi.encode(18));
        baseToken.initialize(BASE_TOKEN_NAME, BASE_TOKEN_NAME, address(priceFeed));
        baseToken.mintMaximumTo(clearingHouse);
        baseToken.addWhitelist(clearingHouse);
        return baseToken;
    }

    function createUniswapV3Factory() internal returns (UniswapV3Factory) {
        UniswapV3Factory uniswapV3Factory;
        uniswapV3Factory = new UniswapV3Factory();
        return uniswapV3Factory;
    }

    function createUniswapV3Pool(
        UniswapV3Factory uniswapV3Factory,
        address baseToken,
        address quoteToken
    ) internal returns (UniswapV3Pool) {
        address poolAddress = uniswapV3Factory.createPool(baseToken, quoteToken, POOL_FEE);
        return UniswapV3Pool(poolAddress);
    }

    function setUp() public {
        quoteToken = createQuoteToken();
        uniswapV3Factory = new UniswapV3Factory();
        marketRegistry = new MarketRegistry();
        marketRegistry.initialize(address(uniswapV3Factory), address(quoteToken));
        ClearingHouse clearingHouse = new ClearingHouse();
        marketRegistry.setClearingHouse(address(clearingHouse));
        baseToken = createBaseToken(address(quoteToken), address(clearingHouse));
        uniswapV3Pool = createUniswapV3Pool(uniswapV3Factory, address(baseToken), address(quoteToken));
    }

    function testCannot_add_pool_before_pool_is_initialized() public {
        vm.mockCall(
            address(uniswapV3Pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(0, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_PNI"));
        marketRegistry.addPool(address(baseToken), POOL_FEE);
    }
}
